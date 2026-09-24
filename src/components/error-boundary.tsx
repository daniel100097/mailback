import { AlertCircle } from "lucide-react";
import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Keeps a crashing page from blanking the whole app (and forcing a reload, which locks the vault). */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="m-auto flex flex-col items-center gap-3 p-6 text-center">
        <AlertCircle className="size-8 text-destructive" />
        <p className="text-sm">Something went wrong: {this.state.error.message}</p>
        <Button variant="outline" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}
