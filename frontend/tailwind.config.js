import tailwindcssAnimate from 'tailwindcss-animate'

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Geist',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif'
        ],
        mono: [
          'Geist Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace'
        ]
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      fontSize: {
        '2xs': ['11px', { lineHeight: '14px', letterSpacing: '0.02em' }],
        xs: ['12px', { lineHeight: '16px' }],
        sm: ['13px', { lineHeight: '18px' }],
        base: ['14px', { lineHeight: '20px' }],
        md: ['15px', { lineHeight: '22px' }],
        lg: ['16px', { lineHeight: '22px' }],
        xl: ['18px', { lineHeight: '24px' }],
        '2xl': ['22px', { lineHeight: '28px', letterSpacing: '-0.018em' }],
        '3xl': ['28px', { lineHeight: '32px', letterSpacing: '-0.022em' }]
      },
      colors: {
        // New token-driven palette
        bg: 'hsl(var(--bg))',
        surface: {
          DEFAULT: 'hsl(var(--surface))',
          muted: 'hsl(var(--surface-muted))',
          sunken: 'hsl(var(--surface-sunken))'
        },
        line: {
          DEFAULT: 'hsl(var(--border-subtle))',
          strong: 'hsl(var(--border-strong))'
        },
        ink: {
          DEFAULT: 'hsl(var(--text))',
          muted: 'hsl(var(--text-muted))',
          faint: 'hsl(var(--text-faint))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          hover: 'hsl(var(--accent-hover))',
          soft: 'hsl(var(--accent-soft))',
          foreground: 'hsl(var(--accent-fg))'
        },
        ok: 'hsl(var(--success))',
        warn: 'hsl(var(--warning))',
        bad: 'hsl(var(--error))',
        info: 'hsl(var(--info))',

        // shadcn-compat aliases (preserve any unmigrated component)
        border: 'hsl(var(--border-subtle))',
        input: 'hsl(var(--border-subtle))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--bg))',
        foreground: 'hsl(var(--text))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-fg))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--surface-muted))',
          foreground: 'hsl(var(--text))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--error))',
          foreground: 'hsl(0 0% 100%)'
        },
        muted: {
          DEFAULT: 'hsl(var(--surface-muted))',
          foreground: 'hsl(var(--text-muted))'
        },
        popover: {
          DEFAULT: 'hsl(var(--surface))',
          foreground: 'hsl(var(--text))'
        },
        card: {
          DEFAULT: 'hsl(var(--surface))',
          foreground: 'hsl(var(--text))'
        }
      },
      boxShadow: {
        hairline: '0 0 0 1px hsl(var(--border-subtle))',
        elevated:
          '0 1px 0 rgba(15, 15, 15, 0.04), 0 8px 24px -12px rgba(15, 15, 15, 0.10)',
        focus: '0 0 0 3px hsl(var(--ring) / 0.18)'
      },
      keyframes: {
        overlayIn: {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        overlayOut: {
          from: { opacity: '1' },
          to: { opacity: '0' }
        },
        drawerIn: {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' }
        },
        drawerOut: {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(100%)' }
        },
        statusDotPulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.62' }
        }
      },
      animation: {
        overlayIn: 'overlayIn 160ms ease-out',
        overlayOut: 'overlayOut 140ms ease-in',
        drawerIn: 'drawerIn 220ms cubic-bezier(0.22, 0.61, 0.36, 1)',
        drawerOut: 'drawerOut 180ms cubic-bezier(0.4, 0, 1, 1)',
        statusDotPulse: 'statusDotPulse 2.2s ease-in-out infinite'
      },
      transitionDuration: {
        120: '120ms'
      }
    }
  },
  plugins: [tailwindcssAnimate]
}
