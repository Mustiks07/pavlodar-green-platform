// Isolated runs (tools/dev/isolated_browser_env.py) skip the identity provider: the runner creates
// sessions for the seeded SYNTHETIC TEST users in its disposable database and lists their cookies
// in PG_SESSIONS. Returns true when the context was signed in that way.
import { readFileSync } from 'node:fs';

export async function sessionCookie(ctx, role, base) {
  if (!process.env.PG_SESSIONS) return false;
  const sessions = JSON.parse(readFileSync(process.env.PG_SESSIONS, 'utf8'));
  if (!sessions[role]) throw new Error(`No isolated session for role ${role}`);
  await ctx.addCookies([{ name: 'pavlodar_session', value: sessions[role].cookie, url: base }]);
  return true;
}
