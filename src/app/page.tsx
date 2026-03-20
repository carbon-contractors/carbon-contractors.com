'use client'

import { useState } from 'react'

export default function ComingSoon() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const handleSubmit = async () => {
    if (!email || !email.includes('@')) return
    // TODO: wire up to your email capture endpoint (Resend, Loops, etc.)
    // await fetch('/api/waitlist', { method: 'POST', body: JSON.stringify({ email }) })
    setSubmitted(true)
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          background: #080808;
          color: #E8E4D8;
          font-family: 'IBM Plex Mono', monospace;
          min-height: 100vh;
        }

        .cc-wrap {
          min-height: 100vh;
          padding: clamp(32px, 6vw, 64px) clamp(24px, 8vw, 80px);
          position: relative;
          overflow: hidden;
        }

        .cc-grid {
          position: fixed;
          inset: 0;
          background-image:
            linear-gradient(rgba(0, 210, 120, 0.035) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0, 210, 120, 0.035) 1px, transparent 1px);
          background-size: 48px 48px;
          pointer-events: none;
          z-index: 0;
        }

        .cc-inner { position: relative; z-index: 1; max-width: 900px; }

        .cc-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: clamp(60px, 12vh, 120px);
        }

        .cc-logo {
          font-size: 11px;
          letter-spacing: 0.20em;
          color: #3E3E3A;
          text-transform: uppercase;
        }

        .cc-status {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          letter-spacing: 0.12em;
          color: #3E3E3A;
        }

        .cc-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #00D27A;
          animation: pulse 2.4s ease-in-out infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.25; }
        }

        .cc-prompt {
          font-size: 11px;
          color: #00D27A;
          letter-spacing: 0.14em;
          margin-bottom: 20px;
        }

        .cc-h1 {
          font-size: clamp(42px, 8vw, 80px);
          font-weight: 300;
          letter-spacing: -0.02em;
          line-height: 1.05;
          margin-bottom: 0;
        }

        .cc-accent { color: #00D27A; }

        .cc-cursor {
          display: inline-block;
          width: 4px;
          height: 0.85em;
          background: #00D27A;
          vertical-align: middle;
          margin-left: 6px;
          animation: blink 1s step-end infinite;
        }

        @keyframes blink {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0; }
        }

        .cc-tagline {
          font-size: 13px;
          color: #4E4E4A;
          letter-spacing: 0.06em;
          line-height: 2;
          margin-top: 28px;
          margin-bottom: 52px;
        }

        .cc-tagline b {
          color: #7A7A72;
          font-weight: 400;
        }

        .cc-form {
          display: flex;
          max-width: 440px;
        }

        .cc-input {
          flex: 1;
          background: #0E0E0C;
          border: 1px solid #222220;
          border-right: none;
          padding: 14px 18px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
          letter-spacing: 0.05em;
          color: #E8E4D8;
          outline: none;
          transition: border-color 0.15s;
        }

        .cc-input::placeholder { color: #2E2E2A; }
        .cc-input:focus { border-color: #00D27A; }

        .cc-btn {
          background: #00D27A;
          border: none;
          padding: 14px 22px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.14em;
          color: #060606;
          cursor: pointer;
          transition: background 0.15s;
          white-space: nowrap;
        }

        .cc-btn:hover { background: #00E88A; }
        .cc-btn:active { background: #00BC6D; }

        .cc-success {
          font-size: 12px;
          letter-spacing: 0.10em;
          color: #00D27A;
          padding: 14px 0;
        }

        .cc-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: clamp(56px, 10vh, 100px);
        }

        .cc-pill {
          font-size: 9px;
          letter-spacing: 0.18em;
          color: #2A2A26;
          border: 1px solid #1A1A18;
          padding: 7px 13px;
        }

        .cc-footer {
          margin-top: 48px;
          font-size: 10px;
          color: #242420;
          letter-spacing: 0.14em;
        }

        @media (max-width: 480px) {
          .cc-form { flex-direction: column; }
          .cc-input { border-right: 1px solid #222220; border-bottom: none; }
        }
      `}</style>

      <div className="cc-wrap">
        <div className="cc-grid" />
        <div className="cc-inner">
          <header className="cc-header">
            <div className="cc-logo">Carbon Contractors</div>
            <div className="cc-status">
              <div className="cc-dot" />
              Building
            </div>
          </header>

          <main>
            <p className="cc-prompt">// coming soon</p>
            <h1 className="cc-h1">
              AI agents<br />
              are <span className="cc-accent">hiring.</span>
              <span className="cc-cursor" />
            </h1>
            <p className="cc-tagline">
              Human work on crypto rails.<br />
              <b>USDC payments</b> · <b>Base network</b> · <b>x402 protocol</b>
            </p>

            {submitted ? (
              <p className="cc-success">✓ you&apos;re on the list</p>
            ) : (
              <div className="cc-form">
                <input
                  className="cc-input"
                  type="email"
                  placeholder="your@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                />
                <button className="cc-btn" onClick={handleSubmit}>
                  GET ACCESS
                </button>
              </div>
            )}
          </main>

          <div className="cc-meta">
            <div className="cc-pill">USDC · BASE</div>
            <div className="cc-pill">x402 PROTOCOL</div>
            <div className="cc-pill">COINBASE SMART WALLET</div>
            <div className="cc-pill">HAAS</div>
          </div>

          <footer className="cc-footer">
            CARBON&#8209;CONTRACTORS.COM &nbsp;·&nbsp; EST. 2025
          </footer>
        </div>
      </div>
    </>
  )
}
