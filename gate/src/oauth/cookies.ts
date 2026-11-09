// The two cookies of the sign-in flow, both set and read only by the gate:
//
//   authz    a random nonce bound into the consent form, so the form can only be submitted
//            from the page the gate served to this browser (SameSite=Strict, 10 minutes).
//   clients  a signed list of the OAuth clients this browser has approved, so Claude Code
//            reconnecting does not ask again (SameSite=Lax, 90 days).
//
// On an https gate they carry the __Host- prefix (Secure, Path=/, no Domain).

import type { Request, Response } from 'express';

export interface CookieNames {
  authz: string;
  clients: string;
  secure: boolean;
}

export function cookieNames(publicUrl: string): CookieNames {
  const secure = publicUrl.startsWith('https:');
  const prefix = secure ? '__Host-' : '';
  return { authz: `${prefix}indulgence-authz`, clients: `${prefix}indulgence-clients`, secure };
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function setCookie(res: Response, names: CookieNames, name: string, value: string, opts: { maxAgeS: number; sameSite: 'Strict' | 'Lax' }) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${opts.sameSite}`, `Max-Age=${opts.maxAgeS}`];
  if (names.secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export function clearCookie(res: Response, names: CookieNames, name: string) {
  setCookie(res, names, name, '', { maxAgeS: 0, sameSite: 'Strict' });
}
