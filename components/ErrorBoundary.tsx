"use client";
import React, { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error in ErrorBoundary:", error, errorInfo);
  }

  public handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-800 my-4 shadow-sm animate-fade-in">
          <h2 className="text-lg font-bold mb-2">💥 Щось пішло не так при роботі редактора</h2>
          <p className="text-sm mb-4 font-mono bg-white p-3 rounded border border-red-100 max-h-36 overflow-y-auto whitespace-pre-wrap">
            {this.state.error?.message || String(this.state.error)}
          </p>
          <button
            onClick={this.handleReset}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm font-medium"
          >
            Скинути помилку 🔄
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
