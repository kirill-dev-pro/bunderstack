# Bunderhost — хостинг-платформа для Bunderstack-приложений

**Дата:** 2026-07-16
**Статус:** утверждено (brainstorming), ждёт план имплементации

## Продукт одним абзацем

Bunderhost — хостинг-платформа для приложений на Bunderstack: пользователь
подключает GitHub-репозиторий, жмёт Deploy и получает работающий прод с
собственной БД (Turso) и S3-бакетом (Tigris), провиженными под организацией
Bunderhost. На каждый PR автоматически поднимается полное preview-окружение:
copy-on-write ветка прод-базы, zero-copy форк прод-бакета, отдельная машина —
и комментарий с URL в PR. Приложение не меняется ни на строчку: локально оно
работает на файловой системе, на платформе получает env-переменные, которые
библиотека уже читает как фолбэк (`DATABASE_URL`, `DATABASE_AUTH_TOKEN`,
`S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` —
см. `packages/bunderstack/src/config.ts` и `src/storage/buckets.ts`).

## Ключевые решения (зафиксированы в брейншторме)

| Развилка | Решение | Отложено |
|---|---|---|
| Скоуп v1 | Полная платформа (deploy + БД + S3 + превью) | — |
| Runtime | Fly Machines API за абстракцией `RuntimeDriver` | VPS- и AWS-драйверы |
| Владение ресурсами | Managed: всё под организацией Bunderhost | BYOK (поле `ownership` в схеме с первого дня) |
| Контракт билда | Zero-config конвенция; `build`/`start` скрипты из package.json уважаются, если есть | Dockerfile-путь |
| БД-провайдер | Turso (libSQL) | Neon — после PGlite/Postgres-поддержки в библиотеке |

## Подтверждённая осуществимость (ресёрч 2026-07-16)

- **Turso Platform API**: создание БД `POST /v1/organizations/{org}/databases`;
  ветка — тот же endpoint с `seed: { type: "database", name: <source> }`
  (copy-on-write, мгновенно). Scoped auth tokens на конкретную БД. Ветки
  считаются в квоту и удаляются вручную.
  Docs: https://docs.turso.tech/features/branching
- **Tigris snapshots/forks**: снапшот — `CreateBucket` c
  `X-Tigris-Snapshot: true` (O(1), метаданные); форк — `CreateBucket` c
  `X-Tigris-Fork-Source-Bucket: <name>` (zero-copy CoW). Работает через
  стандартный AWS SDK. У исходного бакета должны быть включены снапшоты
  (`X-Tigris-Enable-Snapshot: true` при создании); несовместимо с GLACIER и
  TTL-правилами; исходный бакет нельзя удалить, пока живы форки.
  IAM-совместимый API `iam.storage.dev`: CreateAccessKey + policy на
  конкретный бакет. Docs: https://www.tigrisdata.com/docs/buckets/snapshots-and-forks/
- **Миграции**: `provision()` в библиотеке сам применяет закоммиченные
  drizzle-миграции на старте приложения (`provision.ts` — drizzle-orm
  migrator, drizzle-kit в проде не нужен). Платформе отдельный
  migration-раннер не нужен.

## Архитектура — пять компонентов

### Control plane
Веб-дашборд + API, сам написан на Bunderstack (dogfooding). Хранит projects,
environments, deployments, resources, секреты пользователей. Принимает
вебхуки GitHub, оркестрирует provisioner/builder/runtime. Работает на Fly.

### GitHub App
Права: clone репозитория, вебхуки `push` и `pull_request`, комментарии в PR
(URL превью), commit statuses (build/deploy статус).

### Provisioner
Два клиента, оба работают под мастер-кредами организации Bunderhost:

- **Turso**: одна БД на прод-окружение; для превью — БД с
  `seed: {type: "database"}` от продовой; scoped auth token на каждую БД —
  деплой получает доступ только к своей.
- **Tigris**: прод-бакет создаётся сразу с включёнными снапшотами; для
  превью — форк от прод-бакета; на каждое окружение — свой access key с
  policy только на его бакет.

### Builder
clone → `bun install` → определить entry (конвенция: `src/index.ts`, иначе
`main` из package.json; если есть `build`-скрипт — запустить его) →
`bun build --compile` в единый бинарник → минимальный OCI-образ → registry
Fly.

### RuntimeDriver
Интерфейс: `deploy(image, env, machineConfig) → { url, machineId }`,
`destroy(machineId)`, `logs(machineId)`. Первая реализация — Fly Machines
API. Preview-машины со scale-to-zero (спят бесплатно). Драйверы VPS/AWS —
за тем же интерфейсом, потом.

## Модель данных (ядро)

- **Project**: repo, owner, entry-конвенция, привязка к GitHub App
  installation.
- **Environment**: `production` | `preview:pr-<N>`; принадлежит Project.
- **Resource**: `{ kind: db | bucket, provider, providerRef,
  ownership: managed | byo, parentResource? }`; принадлежит Environment.
  `parentResource` у preview-ресурсов указывает на прод-ресурс — задаёт
  порядок удаления и готовит BYOK. В v1 `ownership` всегда `managed`.
- **Deployment**: commit SHA, image, status
  (`building | deploying | live | failed`), machineId; цепочка на
  Environment.
- **Secret**: пользовательские env (ключи Stripe и т.п.), шифруются в
  control plane, инжектятся при деплое наравне с платформенными.

## Основные флоу

### Прод-деплой
push в default branch → webhook → если у environment нет ресурсов,
provisioner создаёт БД + бакет → builder собирает образ → deploy новой
машины с env → приложение на старте само мигрирует БД через `provision()` →
health check → переключение трафика → старая машина гасится.

### Preview
PR opened → ветка БД от прода + форк бакета от прода + scoped-креды
(создаются один раз на PR) → build головы PR → deploy на отдельную машину →
коммент в PR с URL. PR synchronize → только rebuild + redeploy, ресурсы
переиспользуются. PR closed/merged → destroy машины → удалить ветку БД →
удалить форк-бакет → отозвать ключи.

### Очистка
Teardown идемпотентен. Ночной reaper сверяет живые ресурсы у провайдеров
(по неймингу/тегам `bunderhost-<project>-<env>`) со списком открытых PR и
добивает сирот: пропущенные вебхуки — норма жизни. Осиротевшие ветки Turso
едят квоту, форки Tigris блокируют удаление исходного бакета — поэтому
reaper обязателен, не nice-to-have.

## Обработка ошибок

- Билд упал → deployment `failed`, красный commit status, прод не трогаем.
- Миграция на превью упала (данные прода несовместимы с PR-схемой) →
  машина не проходит health check → deployment `failed` с логами. Это
  фича: сломанная миграция видна до мержа.
- Порядок удаления: сначала все форки, потом исходный бакет (ограничение
  Tigris); reaper и teardown это учитывают.
- Мастер-креды Turso/Tigris и пользовательские секреты — шифрованное
  хранилище; это самая чувствительная часть сервиса.

## Тестирование

- Provisioner и RuntimeDriver — за интерфейсами; юнит-тесты на фейках.
- Интеграционные тесты против реальных Turso/Tigris — отдельный набор с
  кредами из env, по образцу существующих `*.integration.test.ts` в
  bunderstack.
- E2E happy-path (webhook → live preview) — на тестовом репозитории,
  запускается вручную/в CI ночью.

## Сознательно не в v1

Кастомные домены (только `*.bunderhost.app` или аналог), BYOK, VPS/AWS
раннеры, Neon/Postgres (после PGlite-спеки), команды и организации,
метрики/логи сверх вывода машины, монорепо.

## Интроспекция декларации (решение, 2026-07-16)

Источник правды о ресурсах приложения — декларация `src/bunderstack.ts`
(конвенция уже живёт в examples: модуль экспортирует `app`). Builder на
этапе интроспекции загружает модуль с безопасным окружением (in-memory БД,
локальный storage) и извлекает манифест: список бакетов с их настройками,
диалект БД, zod-схему `env`. Из env-схемы платформа заранее знает, какие
пользовательские секреты обязательны, и запрашивает их в дашборде до
первого деплоя.

Требуемые изменения в библиотеке:

- **Introspection-режим**: способ получить резолвнутый манифест из
  декларации без побочных эффектов (провижена БД, поднятия сервисов) —
  например `BUNDERSTACK_INTROSPECT=1`, при котором createBunderstack
  возвращает манифест и не трогает внешний мир.
- **Platform-override env**: переменные `BUNDERSTACK_DATABASE_URL`,
  `BUNDERSTACK_DATABASE_AUTH_TOKEN`, `BUNDERSTACK_S3_*` с приоритетом
  **над значениями из кода** (сейчас код побеждает env:
  `parsed.database?.url ?? resolvedEnv.DATABASE_URL`). Иначе приложение с
  захардкоженным `file:./data.db` без env-фолбэка не задеплоится. Обычные
  `DATABASE_URL`/`S3_*` остаются фолбэком с текущей семантикой.

## Открытые вопросы к плану имплементации

- Точный нейминг ресурсов у провайдеров (лимиты длины имён БД/бакетов).
- Fly remote builders vs собственная builder-машина.
- Выбор способа шифрования секретов (KMS vs libsodium sealed box).
