import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from './supabase';

export class ApiError extends Error {}

function clean(msg: string): string {
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Bağlantı yok. İnternetinizi kontrol edip tekrar deneyin.';
  if (/JWT|jwt|token/i.test(msg)) return 'Oturum süresi doldu, tekrar giriş yapın.';
  return msg.replace(/^.*?ERROR:\s*/, '');
}

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new ApiError(clean(error.message));
  return data as T;
}

export async function invoke<T = unknown>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const j = await error.context.json().catch(() => null);
      throw new ApiError(clean(j?.error ?? error.message));
    }
    throw new ApiError(clean(error.message));
  }
  return data as T;
}

export function errText(e: unknown): string {
  return e instanceof Error ? clean(e.message) : String(e);
}
