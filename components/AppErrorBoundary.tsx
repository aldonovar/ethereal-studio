import React from 'react';

interface AppErrorBoundaryProps {
    children: React.ReactNode;
}

interface AppErrorBoundaryState {
    hasError: boolean;
}

export class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
    state: AppErrorBoundaryState = { hasError: false };

    static getDerivedStateFromError(): AppErrorBoundaryState {
        return { hasError: true };
    }

    componentDidCatch(error: unknown): void {
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        console.error(`DAW-fi UI recovery boundary: ${errorName}`);
    }

    private retryInterface = (): void => {
        this.setState({ hasError: false });
    };

    private reloadApplication = (): void => {
        window.location.reload();
    };

    render(): React.ReactNode {
        if (!this.state.hasError) return this.props.children;

        return (
            <main
                data-app-error-fallback="true"
                role="alert"
                style={{
                    minHeight: '100dvh',
                    display: 'grid',
                    placeItems: 'center',
                    padding: '24px',
                    background: '#101114',
                    color: '#f3f4f6',
                    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
                }}
            >
                <section style={{ width: 'min(100%, 460px)', border: '1px solid #34363b', background: '#191b1f', padding: '24px' }}>
                    <div style={{ color: '#9ca3af', fontSize: '11px', letterSpacing: '0.16em', textTransform: 'uppercase' }}>DAW-fi</div>
                    <h1 style={{ margin: '12px 0 8px', fontSize: '20px', fontWeight: 600 }}>La interfaz necesita recuperarse</h1>
                    <p style={{ margin: 0, color: '#b8bcc4', fontSize: '14px', lineHeight: 1.6 }}>
                        El motor detuvo esta vista para evitar una pantalla vacía. Tus proyectos locales no se eliminan.
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginTop: '20px' }}>
                        <button type="button" onClick={this.retryInterface} style={{ minHeight: '44px', border: '1px solid #d1d5db', background: '#f3f4f6', color: '#111827', fontWeight: 600, cursor: 'pointer' }}>
                            Reintentar interfaz
                        </button>
                        <button type="button" onClick={this.reloadApplication} style={{ minHeight: '44px', border: '1px solid #4b4f57', background: '#24272c', color: '#f3f4f6', fontWeight: 600, cursor: 'pointer' }}>
                            Recargar DAW-fi
                        </button>
                    </div>
                </section>
            </main>
        );
    }
}
