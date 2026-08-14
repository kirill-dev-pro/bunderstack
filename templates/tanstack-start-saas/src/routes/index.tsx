import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { DeliveryRail } from '~/components/delivery-rail'
import { Button } from '~/components/ui/button'

export const Route = createFileRoute('/')({
  component: LandingPage,
})

function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col justify-between bg-[#F6F3E9] p-6 text-[#17211B] md:p-12">
      {/* Header / Nav */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between border-b border-[#17211B]/10 py-4">
        <div className="flex items-center space-x-8">
          <span className="font-display text-2xl font-bold tracking-tight">
            BunderSaaS
          </span>
          <nav className="hidden space-x-6 text-sm font-medium text-[#17211B]/80 sm:flex">
            <span>Product</span>
            <span>Client Workspace</span>
            <span>Admin Portal</span>
          </nav>
        </div>
        <div className="flex items-center space-x-4">
          <Button variant="ghost" asChild>
            <Link to="/login">Sign in</Link>
          </Button>
          <Button variant="default" asChild>
            <Link to="/register">Start a workspace</Link>
          </Button>
        </div>
      </header>

      {/* Main Hero Section */}
      <main className="mx-auto my-12 grid w-full max-w-6xl grid-cols-1 items-center gap-12 md:grid-cols-12">
        <div className="space-y-6 md:col-span-7">
          <span className="inline-flex items-center rounded-full bg-[#DCEBDD] px-3 py-1 font-mono text-xs tracking-wider text-[#17211B] uppercase">
            BunderSaaS Template for TanStack Start
          </span>
          <h1 className="font-display text-5xl leading-[1.1] font-bold tracking-tight md:text-6xl">
            Deliver the work, not the status meeting.
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-[#17211B]/80">
            BunderSaaS pairs client workspaces and admin portals with live
            delivery rails, owner-scoped CRUD, and background queue workers on
            Bunderstack.
          </p>
          <div className="flex flex-wrap gap-4 pt-2">
            <Button size="lg" variant="default" asChild>
              <Link to="/register">Start a workspace</Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link to="/login">Sign in to workspace</Link>
            </Button>
          </div>
        </div>

        {/* Live Delivery Rail Demonstration */}
        <div className="rounded-[10px] border border-[#17211B]/10 bg-[#FFFDF7] p-6 shadow-sm md:col-span-5">
          <DeliveryRail />
        </div>
      </main>

      {/* Footer */}
      <footer className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between border-t border-[#17211B]/10 py-6 text-xs text-[#17211B]/60 sm:flex-row">
        <p>
          © {new Date().getFullYear()} BunderSaaS. Built on Bunderstack +
          TanStack Start.
        </p>
        <div className="mt-2 flex space-x-4 sm:mt-0">
          <span>Documentation</span>
          <span>Privacy</span>
          <span>Terms</span>
        </div>
      </footer>
    </div>
  )
}
