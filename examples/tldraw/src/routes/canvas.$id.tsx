import type { TypeId } from 'bunderstack/typeid'

import { useLiveQuery, eq } from '@tanstack/react-db'
import {
  ClientOnly,
  Link,
  createFileRoute,
  redirect,
} from '@tanstack/react-router'
import * as React from 'react'
import { toast } from 'sonner'

import { filesApi } from '~/api-client'
import {
  SHAPE_TOOLS,
  createClientTypeId,
  createShapeDraft,
  shapeListParams,
  type ShapeType,
} from '~/utils/canvas-data'
import { fetchCanvas } from '~/utils/canvas-loader'

const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed'] as const

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export const Route = createFileRoute('/canvas/$id')({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: '/login' })
  },
  loader: async ({ params }) => {
    const canvas = await fetchCanvas({ data: params.id })
    if (!canvas) throw redirect({ to: '/canvas' })

    return { canvas }
  },
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <ClientOnly
      fallback={
        <div className="grid min-h-[calc(100vh-57px)] place-items-center bg-white text-slate-500">
          Loading whiteboard...
        </div>
      }
    >
      <WhiteboardClient />
    </ClientOnly>
  )
}

function WhiteboardClient() {
  const { id } = Route.useParams()
  const { canvas } = Route.useLoaderData()
  const { api, user } = Route.useRouteContext()
  const boardRef = React.useRef<HTMLDivElement>(null)
  const imageInputRef = React.useRef<HTMLInputElement>(null)
  const pendingImagePointRef = React.useRef<{ x: number; y: number } | null>(
    null,
  )
  const [viewport, setViewport] = React.useState({ x: 180, y: 120, scale: 1 })
  const [activeTool, setActiveTool] = React.useState<ShapeType>('rectangle')
  const [uploadingImage, setUploadingImage] = React.useState(false)
  const [pan, setPan] = React.useState<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const [drag, setDrag] = React.useState<{
    id: string
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const [draftPositions, setDraftPositions] = React.useState<
    Record<string, { x: number; y: number }>
  >({})
  const params = React.useMemo(() => shapeListParams(id), [id])

  React.useEffect(() => {
    void api.realtime?.subscribe(['shape'])
    void api.shape.table
      .list(params)
      .then((page) => {
        for (const shape of page.items) {
          api.shape.collection.utils.writeUpsert(shape)
        }
      })
      .catch((error: Error) => toast.error(error.message))
  }, [api.realtime, api.shape.collection.utils, api.shape.table, params])

  const { data: shapes = [] } = useLiveQuery((query) =>
    query
      .from({ shape: api.shape.collection })
      .where(({ shape }) => eq(shape.canvasId, params.canvasId))
      .orderBy(({ shape }) => shape.createdAt, params.order)
      .limit(params.limit)
      .select(({ shape }) => shape),
  )

  const screenToWorld = React.useCallback(
    (clientX: number, clientY: number) => {
      const rect = boardRef.current?.getBoundingClientRect()
      if (!rect) return { x: 0, y: 0 }

      return {
        x: (clientX - rect.left - viewport.x) / viewport.scale,
        y: (clientY - rect.top - viewport.y) / viewport.scale,
      }
    },
    [viewport],
  )

  const addShapeAt = React.useCallback(
    (
      clientX: number,
      clientY: number,
      type: ShapeType = activeTool,
      options: {
        text?: string
        imageFileId?: string
        imageName?: string
      } = {},
    ) => {
      if (!canvas) {
        toast.error('Canvas is not ready yet')
        return
      }

      const point = screenToWorld(clientX, clientY)
      const color = COLORS[shapes.length % COLORS.length]
      const draft = createShapeDraft(type, point, color, options)

      const now = new Date()
      api.shape.collection.insert({
        id: createClientTypeId('shape'),
        canvasId: id as TypeId<'canvas'>,
        ownerId: user!.id,
        ...draft,
        createdAt: now,
        updatedAt: now,
      })
    },
    [
      activeTool,
      api.shape.collection,
      canvas,
      id,
      screenToWorld,
      shapes.length,
      user,
    ],
  )

  const addShapeInCenter = () => {
    const rect = boardRef.current?.getBoundingClientRect()
    if (!rect) return
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }

    if (activeTool === 'image') {
      pendingImagePointRef.current = point
      imageInputRef.current?.click()
      return
    }

    addShapeAt(point.x, point.y, activeTool, promptOptions(activeTool))
  }

  async function uploadImageShape(file: File) {
    const rect = boardRef.current?.getBoundingClientRect()
    const point =
      pendingImagePointRef.current ??
      (rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null)
    pendingImagePointRef.current = null
    if (!point) return

    setUploadingImage(true)
    try {
      const uploaded = await filesApi.files.images.upload(file)
      addShapeAt(point.x, point.y, 'image', {
        imageFileId: uploaded.fileId,
        imageName: uploaded.name,
      })
      toast.success('Image added')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Image upload failed')
    } finally {
      setUploadingImage(false)
    }
  }

  const commitDrag = React.useCallback(() => {
    if (!drag) return

    const position = draftPositions[drag.id]
    if (position) {
      api.shape.collection.update(drag.id, (draft) => {
        draft.x = Math.round(position.x)
        draft.y = Math.round(position.y)
        draft.updatedAt = new Date()
      })
    }

    setDrag(null)
    setDraftPositions((positions) => {
      const next = { ...positions }
      delete next[drag.id]
      return next
    })
  }, [api.shape.collection, draftPositions, drag])

  return (
    <div className="flex h-full min-h-[calc(100vh-57px)] flex-col bg-slate-100 text-slate-950">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-white px-4 py-3 shadow-sm">
        <div className="min-w-0">
          <Link to="/" className="text-sm font-medium text-blue-600">
            Back home
          </Link>
          <span className="px-2 text-sm text-slate-300">/</span>
          <Link to="/canvas" className="text-sm font-medium text-blue-600">
            Canvases
          </Link>
          <h1 className="truncate text-xl font-black">
            {canvas?.name ?? 'Canvas'}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <div className="flex rounded-full bg-slate-100 p-1">
            {SHAPE_TOOLS.map((tool) => (
              <button
                key={tool.type}
                type="button"
                className={`rounded-full px-3 py-1 font-semibold transition ${
                  activeTool === tool.type
                    ? 'bg-slate-950 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-white'
                }`}
                onClick={() => setActiveTool(tool.type)}
              >
                {tool.label}
              </button>
            ))}
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">
            Drag empty space to pan
          </span>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            disabled={uploadingImage}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void uploadImageShape(file)
              event.currentTarget.value = ''
            }}
          />
          <button
            type="button"
            className="rounded-full bg-slate-950 px-4 py-2 font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            onClick={addShapeInCenter}
            disabled={!canvas || uploadingImage}
          >
            {uploadingImage ? 'Uploading image...' : `Add ${activeTool}`}
          </button>
        </div>
      </div>

      <div
        ref={boardRef}
        className={`relative min-h-0 flex-1 touch-none overflow-hidden bg-white ${
          pan ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgb(148 163 184 / 0.45) 1px, transparent 0)',
          backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          backgroundSize: `${32 * viewport.scale}px ${32 * viewport.scale}px`,
        }}
        onDoubleClick={(event) => {
          if (event.target !== event.currentTarget) return
          if (activeTool === 'image') {
            pendingImagePointRef.current = {
              x: event.clientX,
              y: event.clientY,
            }
            imageInputRef.current?.click()
            return
          }

          addShapeAt(
            event.clientX,
            event.clientY,
            activeTool,
            promptOptions(activeTool),
          )
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.target !== event.currentTarget) return
          event.currentTarget.setPointerCapture(event.pointerId)
          setPan({
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: viewport.x,
            originY: viewport.y,
          })
        }}
        onPointerMove={(event) => {
          if (pan && pan.pointerId === event.pointerId) {
            setViewport((current) => ({
              ...current,
              x: pan.originX + event.clientX - pan.startX,
              y: pan.originY + event.clientY - pan.startY,
            }))
          }

          if (drag) {
            const nextX =
              drag.originX + (event.clientX - drag.startX) / viewport.scale
            const nextY =
              drag.originY + (event.clientY - drag.startY) / viewport.scale
            setDraftPositions((positions) => ({
              ...positions,
              [drag.id]: { x: nextX, y: nextY },
            }))
          }
        }}
        onPointerUp={(event) => {
          if (pan?.pointerId === event.pointerId) setPan(null)
          commitDrag()
        }}
        onPointerCancel={() => {
          setPan(null)
          commitDrag()
        }}
        onWheel={(event) => {
          event.preventDefault()
          const rect = boardRef.current?.getBoundingClientRect()
          if (!rect) return

          setViewport((current) => {
            const nextScale = clamp(
              current.scale * (event.deltaY > 0 ? 0.9 : 1.1),
              0.25,
              2.5,
            )
            const pointerX = event.clientX - rect.left
            const pointerY = event.clientY - rect.top
            const worldX = (pointerX - current.x) / current.scale
            const worldY = (pointerY - current.y) / current.scale

            return {
              scale: nextScale,
              x: pointerX - worldX * nextScale,
              y: pointerY - worldY * nextScale,
            }
          })
        }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          }}
        >
          {shapes.map((shape) => {
            const position = draftPositions[shape.id] ?? shape
            const shapeType = shape.type as ShapeType

            return (
              <button
                key={shape.id}
                type="button"
                aria-label={shapeAccessibleName(shape, shapeType)}
                className={`absolute cursor-move overflow-hidden border-2 bg-white/90 p-0 shadow-lg outline-none transition focus:ring-4 focus:ring-blue-200 ${shapeClassName(shapeType)}`}
                style={{
                  left: position.x,
                  top: position.y,
                  width: shape.width,
                  height: shape.height,
                  rotate: `${shape.rotation}deg`,
                  borderColor: shape.color,
                  color: shape.color,
                  clipPath:
                    shapeType === 'diamond'
                      ? 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)'
                      : undefined,
                }}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  setDrag({
                    id: shape.id,
                    startX: event.clientX,
                    startY: event.clientY,
                    originX: position.x,
                    originY: position.y,
                  })
                }}
              >
                <ShapeContents shape={shape} type={shapeType} />
              </button>
            )
          })}
        </div>

        {shapes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="rounded-3xl border bg-white/90 p-6 text-center shadow-xl">
              <h2 className="text-xl font-black">Start anywhere</h2>
              <p className="mt-1 max-w-xs text-sm text-slate-500">
                Double-click the whiteboard or use Add shape to create the first
                object.
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function promptOptions(type: ShapeType) {
  if (type !== 'text') return {}

  return {
    text:
      window.prompt('Text for this note', 'New idea')?.trim() || 'New idea',
  }
}

function shapeClassName(type: ShapeType) {
  switch (type) {
    case 'ellipse':
      return 'rounded-full'
    case 'diamond':
      return 'rounded-none'
    case 'text':
      return 'rounded-2xl bg-amber-50/95'
    case 'image':
      return 'rounded-3xl bg-slate-100'
    default:
      return 'rounded-2xl'
  }
}

function shapeAccessibleName(
  shape: {
    imageName?: string | null
    text?: string | null
  },
  type: ShapeType,
) {
  if (type === 'text') return shape.text ?? 'Text shape'
  if (type === 'image') return shape.imageName ?? 'Image shape'
  if (type === 'ellipse') return 'Ellipse shape'
  if (type === 'diamond') return 'Diamond shape'
  return 'Rectangle shape'
}

function ShapeContents({
  shape,
  type,
}: {
  shape: {
    color: string
    imageFileId?: string | null
    imageName?: string | null
    text?: string | null
  }
  type: ShapeType
}) {
  if (type === 'image') {
    if (!shape.imageFileId) {
      return (
        <span className="grid h-full place-items-center px-4 text-sm font-bold text-slate-500">
          Missing image
        </span>
      )
    }

    return (
      <img
        src={filesApi.files.images.url(shape.imageFileId, {
          w: 640,
          format: 'webp',
        })}
        alt={shape.imageName ?? 'Whiteboard image'}
        className="h-full w-full object-cover"
        draggable={false}
      />
    )
  }

  if (type === 'text') {
    return (
      <span className="grid h-full place-items-center px-4 text-center text-lg font-black leading-tight text-slate-900">
        {shape.text ?? 'Text'}
      </span>
    )
  }

  return (
    <span className="grid h-full place-items-center text-sm font-bold">
      {type === 'ellipse' ? 'Ellipse' : type === 'diamond' ? 'Diamond' : 'Shape'}
    </span>
  )
}
