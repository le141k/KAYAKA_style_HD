import { afterEach, describe, expect, it, vi } from 'vitest';
import { canRefreshAfterUnauthorized } from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('cookie-session retry policy', () => {
  it('refreshes before logout when the short-lived access cookie expired', () => {
    expect(canRefreshAfterUnauthorized('/auth/logout')).toBe(true);
  });

  it('does not turn a failed login or reset request into refresh-token replay', () => {
    expect(canRefreshAfterUnauthorized('/auth/login')).toBe(false);
    expect(canRefreshAfterUnauthorized('/auth/forgot-password')).toBe(false);
    expect(canRefreshAfterUnauthorized('/auth/reset-password')).toBe(false);
  });
});

describe('CSRF bootstrap and recovery', () => {
  it('revalidates an existing cookie once and coalesces concurrent callers', async () => {
    vi.stubGlobal('document', { cookie: '__Host-th_csrf=stale' });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ csrfToken: 'fresh' }));
    vi.stubGlobal('fetch', fetchMock);
    const { getCsrfToken } = await import('./api');

    await expect(Promise.all([getCsrfToken(), getCsrfToken()])).resolves.toEqual(['fresh', 'fresh']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/api/auth/csrf',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
  });

  it('refreshes and safely retries once after a guard-specific CSRF rejection', async () => {
    vi.stubGlobal('document', { cookie: '__Host-th_csrf=stale' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'fresh-1' }))
      .mockResolvedValueOnce(jsonResponse({ code: 'CSRF_TOKEN_INVALID' }, 403))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'fresh-2' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('./api');

    await expect(api.post('/tickets', { subject: 'test' })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-CSRF-Token': 'fresh-1' }),
      }),
    );
    expect(fetchMock.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-CSRF-Token': 'fresh-2' }),
      }),
    );
  });

  it('sends a versioned DELETE body for optimistic server-side delete fences', async () => {
    vi.stubGlobal('document', { cookie: '' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-delete' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('./api');

    await expect(
      api.delete('/admin/email-queues/7', { expectedConfigGeneration: 4 }),
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ expectedConfigGeneration: 4 }),
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-delete' }),
      }),
    );
  });
});
