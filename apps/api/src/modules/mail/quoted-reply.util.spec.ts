import { describe, it, expect } from 'vitest';
import { stripQuotedReply } from './quoted-reply.util';

describe('stripQuotedReply', () => {
  it('cuts at the Kayako "----- Original Message -----" marker', () => {
    const body = 'Thanks, that fixed it!\n\n----- Original Message -----\nFrom: support\nblah blah';
    expect(stripQuotedReply(body)).toBe('Thanks, that fixed it!');
  });

  it('cuts at the HTML break-line marker', () => {
    const body = 'New reply text<!-- Break Line -->old quoted html';
    expect(stripQuotedReply(body)).toBe('New reply text');
  });

  it('cuts at an "On <date>, <person> wrote:" quote header', () => {
    const body = 'Confirmed working now.\nOn Mon, 1 Jan 2026, NOC wrote:\n> previous message';
    expect(stripQuotedReply(body)).toBe('Confirmed working now.');
  });

  it('returns the body unchanged when no marker is present', () => {
    const body = 'Just a normal message with no quote.';
    expect(stripQuotedReply(body)).toBe(body);
  });

  it('keeps the original when stripping would empty the body', () => {
    const body = '----- Original Message -----\nonly quoted content';
    expect(stripQuotedReply(body)).toBe(body);
  });

  it('uses the earliest of several markers', () => {
    const body = 'keep\nFrom: a@b.com\n-----Original Message-----\nx';
    expect(stripQuotedReply(body)).toBe('keep');
  });
});
