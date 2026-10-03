// Comportamiento de BlackForge sobre componentes de Bambuddy (enganches
// BLACKFORGE). Las banderas están apagadas en las pruebas por defecto (ver
// theme/config.ts); aquí se encienden como en la app real.
import '@testing-library/jest-dom/vitest'; // tipos de los matchers (tsc revisa también estas pruebas)
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../../i18n';
import { server } from '../../__tests__/mocks/server';
import { render } from '../../__tests__/utils';
import { AuthProvider } from '../../contexts/AuthContext';
import { ThemeProvider, useTheme } from '../../contexts/ThemeContext';
import { Layout } from '../../components/Layout';
import { BlackForgeSidebarFooter } from '../components/SidebarFooter';
import { registerBlackForgeI18n } from '../i18n';

vi.mock('../theme/config', () => ({ BLACKFORGE_DARK_ONLY: true, BLACKFORGE_HIDE_BUG_REPORT: true }));

const defaultMatchMedia = window.matchMedia;

function stubViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      return { ...defaultMatchMedia(query), matches: max ? width <= Number(max[1]) : false };
    },
  });
}

function setupLayoutHandlers() {
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json([])),
    http.get('/api/v1/version', () => HttpResponse.json({ version: '1.2.5.7', build: 'test' })),
    http.get('/api/v1/settings/', () => HttpResponse.json({ check_updates: false, check_printer_firmware: false })),
    http.get('/api/v1/external-links/', () => HttpResponse.json([])),
    http.get('/api/v1/smart-plugs/', () => HttpResponse.json([])),
    http.get('/api/v1/support/debug-logging', () => HttpResponse.json({ enabled: false })),
    http.get('/api/v1/queue/', () => HttpResponse.json([])),
    http.get('/api/v1/pending-uploads/count', () => HttpResponse.json({ count: 0 })),
    http.get('/api/v1/updates/check', () => HttpResponse.json({ update_available: false })),
    http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: false, requires_setup: false })),
    http.get('/api/v1/printers/developer-mode-warnings', () => HttpResponse.json([])),
    http.get('/api/v1/system/health', () => HttpResponse.json({ findings: [] })),
  );
}

beforeAll(() => registerBlackForgeI18n(i18n));

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: defaultMatchMedia });
});

describe('tema solo oscuro', () => {
  function wrapper({ children }: { children: ReactNode }) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ThemeProvider>{children}</ThemeProvider>
        </AuthProvider>
      </QueryClientProvider>
    );
  }

  beforeEach(() => {
    document.documentElement.className = '';
  });

  it('se ve oscuro aunque alguien elija el modo claro', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setMode('light'));
    expect(result.current.resolvedMode).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('se ve oscuro aunque el sistema prefiera el claro', () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setMode('system'));
    expect(result.current.resolvedMode).toBe('dark');
  });
});

describe('barra lateral y encabezado', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    setupLayoutHandlers();
  });

  it('en el celular no muestra el botón de reportar errores a Bambuddy', async () => {
    stubViewport(390);
    render(<Layout />);
    await waitFor(() => expect(document.querySelector('header')).toBeInTheDocument());
    const header = document.querySelector('header')!;
    expect(within(header).queryByRole('button', { name: /report a bug|bug/i })).toBeNull();
  });

  it('en escritorio no muestra el botón flotante y sí el pie de BlackForge', async () => {
    stubViewport(1440);
    render(<Layout />);
    await waitFor(() => expect(screen.getByTestId('blackforge-sidebar-footer')).toBeInTheDocument());
    const floatingDisc = Array.from(document.querySelectorAll('button')).find(
      (b) => b.className.includes('rounded-full') && b.className.includes('bottom-4'),
    );
    expect(floatingDisc).toBeUndefined();
  });
});

describe('enlace «Código fuente» (AGPL)', () => {
  beforeEach(() => {
    void i18n.changeLanguage('es');
  });

  afterEach(() => {
    void i18n.changeLanguage('en');
  });

  it('da crédito a Bambuddy', async () => {
    render(<BlackForgeSidebarFooter />);
    const link = await screen.findByRole('link', { name: 'Basado en Bambuddy' });
    expect(link).toHaveAttribute('href', 'https://github.com/maziggy/bambuddy');
  });

  it('descarga el paquete del código fuente', async () => {
    server.use(
      http.get('*/api/v1/blackforge/codigo-fuente', () =>
        new HttpResponse(new Uint8Array([0x1f, 0x8b]), { headers: { 'Content-Type': 'application/gzip' } }),
      ),
    );
    const createObjectURL = vi.fn(() => 'blob:codigo');
    const clicked: string[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });

    render(<BlackForgeSidebarFooter />);
    fireEvent.click(await screen.findByRole('button', { name: /Código fuente/ }));

    await waitFor(() => expect(clicked).toEqual(['blackforge-print-codigo-fuente.tar.gz']));
    expect(createObjectURL).toHaveBeenCalledOnce();
    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('explica cuándo el paquete no está disponible', async () => {
    server.use(
      http.get('*/api/v1/blackforge/codigo-fuente', () => HttpResponse.json({ detail: 'no' }, { status: 404 })),
    );
    render(<BlackForgeSidebarFooter />);
    fireEvent.click(await screen.findByRole('button', { name: /Código fuente/ }));
    expect(await screen.findByText(/se incluye al construir la imagen Docker/)).toBeInTheDocument();
  });
});
