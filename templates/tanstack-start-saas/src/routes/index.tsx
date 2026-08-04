import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'
import { DeliveryRail } from '~/components/delivery-rail'
import { Button } from '~/components/ui/button'

export const Route = createFileRoute('/')({
  component: LandingPage,
})

function LandingPage() {
  return (
    <div className="min-h-screen bg-[#F6F3E9] text-[#17211B] flex flex-col justify-between p-6 md:p-12">
      {/* Header / Nav */}
      <header className="max-w-6xl w-full mx-auto flex items-center justify-between py-4 border-b border-[#17211B]/10">
        <div className="flex items-center space-x-8">
          <span className="font-display text-2xl font-bold tracking-tight">BunderSaaS</span>
          <nav className="hidden sm:flex space-x-6 text-sm font-medium text-[#17211B]/80">
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
      <main className="max-w-6xl w-full mx-auto my-12 grid grid-cols-1 md:grid-cols-12 gap-12 items-center">
        <div className="md:col-span-7 space-y-6">
          <span className="inline-flex items-center font-mono text-xs uppercase tracking-wider px-3 py-1 rounded-full bg-[#DCEBDD] text-[#17211B]">
            BunderSaaS Template for TanStack Start
          </span>
          <h1 className="font-display text-5xl md:text-6xl font-bold tracking-tight leading-[1.1]">
            Deliver the work, not the status meeting.
          </h1>
          <p className="text-lg text-[#17211B]/80 leading-relaxed max-w-xl">
            BunderSaaS pairs client workspaces and admin portals with live delivery rails, owner-scoped CRUD, and background queue workers on Bunderstack.
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
        <div className="md:col-span-5 bg-[#FFFDF7] p-6 rounded-[10px] border border-[#17211B]/10 shadow-sm">
          <DeliveryRail />
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-6xl w-full mx-auto py-6 border-t border-[#17211B]/10 flex flex-col sm:flex-row items-center justify-between text-xs text-[#17211B]/60">
        <p>© {new Date().getFullYear()} BunderSaaS. Built on Bunderstack + TanStack Start.</p>
        <div className="flex space-x-4 mt-2 sm:mt-0">
          <span>Documentation</span>
          <span>Privacy</span>
          <span>Terms</span>
        </div>
      </footer>
    </div>
  )
}
