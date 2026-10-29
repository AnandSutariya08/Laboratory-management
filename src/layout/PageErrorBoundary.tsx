import { Component, type ReactNode } from 'react'
import { Result } from 'antd'
import { Button } from '../design/Button'

// Catches a crash inside one page so the rest of the app (sidebar, top bar, other pages) keeps working.
// Reset by `resetKey` (the route), so moving to another page clears the error.
export class PageErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('Page crashed', error)
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <Result
        status="warning"
        title="This page ran into a problem"
        subTitle="The rest of the app still works. Try again, or open another page from the menu."
        extra={<Button variant="primary" onClick={() => this.setState({ error: null })}>Try again</Button>}
      />
    )
  }
}
