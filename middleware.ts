import { NextRequest, NextResponse } from 'next/server'

// Routes that bypass the coming soon redirect
const BYPASS = [
  '/api/',          // keep API routes live
  '/_next/',        // Next.js internals
  '/favicon',       // favicon
  '/robots',        // robots.txt
  '/sitemap',       // sitemap
]

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Let bypass routes through
  if (BYPASS.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next()
  }

  // Everything else → root (coming soon page)
  if (pathname !== '/') {
    return NextResponse.redirect(new URL('/', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Match all paths except static files.
     * Adjust when you're ready to go live — remove this file entirely
     * or flip COMING_SOON env var check below.
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
