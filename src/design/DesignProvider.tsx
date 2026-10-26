import { useMemo, type ReactNode } from 'react'
import { ConfigProvider } from 'antd'
import { buildTheme } from '../theme'
import { DisplaySettingsProvider, useDisplay } from './DisplaySettings'

function Themed({ children }: { children: ReactNode }) {
  const { resolved } = useDisplay()
  const cfg = useMemo(
    () => buildTheme({ dark: resolved.scheme === 'dark', highContrast: resolved.contrast === 'more' }),
    [resolved.scheme, resolved.contrast],
  )
  return (
    <ConfigProvider theme={cfg} wave={{ disabled: resolved.motion === 'reduce' }}>
      {children}
    </ConfigProvider>
  )
}

// Display settings (theme, reduce motion/transparency, increase contrast) plus
// the Ant Design theme derived from them.
export function DesignProvider({ children }: { children: ReactNode }) {
  return (
    <DisplaySettingsProvider>
      <Themed>{children}</Themed>
    </DisplaySettingsProvider>
  )
}
