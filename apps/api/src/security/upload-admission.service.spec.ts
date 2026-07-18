import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration';
import { UploadAdmissionService } from './upload-admission.service';

const MIB = 1024 * 1024;

function request(headers: Record<string, string> = {}) {
  return { headers, ip: '203.0.113.9' } as never;
}

function harness(configOverrides: Partial<AppConfig> = {}) {
  const quota = { consume: vi.fn().mockResolvedValue(undefined) };
  const capacity = { assertCanAccept: vi.fn().mockResolvedValue(undefined) };
  const config = {
    NODE_ENV: 'production',
    TELECOM_HD_PUBLIC_UPLOAD_ENABLED: true,
    TELECOM_HD_CLIENT_UPLOAD_ENABLED: true,
    TELECOM_HD_UPLOAD_REQUEST_MAX_SIZE_MB: 51,
    ...configOverrides,
  } as AppConfig;
  return {
    quota,
    capacity,
    service: new UploadAdmissionService(quota as never, capacity as never, config),
  };
}

describe('UploadAdmissionService', () => {
  it('fails closed on the shared public-upload kill switch', () => {
    const { service } = harness({ TELECOM_HD_PUBLIC_UPLOAD_ENABLED: false });
    expect(() => service.validateContentLength(request({ 'content-length': '100' }), 'public')).toThrow(
      NotFoundException,
    );
  });

  it('uses an independent verified-client upload kill switch', () => {
    const { service } = harness({
      TELECOM_HD_PUBLIC_UPLOAD_ENABLED: true,
      TELECOM_HD_CLIENT_UPLOAD_ENABLED: false,
    });
    expect(() => service.validateContentLength(request({ 'content-length': '100' }), 'public')).not.toThrow();
    expect(() => service.validateContentLength(request({ 'content-length': '100' }), 'client')).toThrow(
      NotFoundException,
    );
  });

  it.each([
    [{}, BadRequestException],
    [{ 'transfer-encoding': 'chunked' }, BadRequestException],
    [{ 'content-length': '0' }, BadRequestException],
    [{ 'content-length': '12, 13' }, BadRequestException],
  ])('rejects unreservable HTTP framing before Multer (%o)', (headers, error) => {
    const { service } = harness();
    expect(() => service.validateContentLength(request(headers), 'public')).toThrow(error);
  });

  it('accepts the configured request boundary and rejects one byte above it', () => {
    const { service } = harness();
    expect(service.validateContentLength(request({ 'content-length': String(51 * MIB) }), 'public')).toBe(
      51 * MIB,
    );
    expect(() =>
      service.validateContentLength(request({ 'content-length': String(51 * MIB + 1) }), 'public'),
    ).toThrow(PayloadTooLargeException);
  });

  it('reserves request and bytes once, then checks shared capacity', async () => {
    const { service, quota, capacity } = harness();
    const req = request({ 'content-length': '4096' });

    await service.reserve(req, 4096, 'client', '42');

    expect(quota.consume).toHaveBeenCalledTimes(2);
    expect(quota.consume).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: 'client-upload-request', cost: 1, identity: '42' }),
    );
    expect(quota.consume).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: 'client-upload-bytes', cost: 4096, identity: '42' }),
    );
    expect(capacity.assertCanAccept).toHaveBeenCalledOnce();
    expect(capacity.assertCanAccept).toHaveBeenCalledWith(4096, 1);
  });
});
