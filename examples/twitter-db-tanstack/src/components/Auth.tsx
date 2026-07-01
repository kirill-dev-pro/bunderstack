import { Button } from '~/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import { Input } from '~/components/ui/input'

export function Auth({
  actionText,
  onSubmit,
  onSecondaryClick,
  secondaryLabel,
  status,
  message,
}: {
  actionText: string
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void
  onSecondaryClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  secondaryLabel?: string
  status: 'pending' | 'idle' | 'success' | 'error'
  message?: string | null
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{actionText}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              onSubmit(e)
            }}
          >
            <div className="space-y-1.5">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <Input
                type="email"
                name="email"
                id="email"
                required
                autoComplete="email"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <Input
                type="password"
                name="password"
                id="password"
                required
                autoComplete="current-password"
              />
            </div>
            {message ? (
              <p className="text-destructive text-sm" role="alert">
                {message}
              </p>
            ) : null}
            <Button
              type="submit"
              className="w-full"
              disabled={status === 'pending'}
            >
              {status === 'pending' ? 'Please wait…' : actionText}
            </Button>
            {onSecondaryClick && secondaryLabel ? (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={status === 'pending'}
                onClick={onSecondaryClick}
              >
                {secondaryLabel}
              </Button>
            ) : null}
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
