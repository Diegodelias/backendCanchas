import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  consumeLoginToken,
  createLoginToken,
  hasLiveInvite,
  LINK_TTL_MS,
  PLAYER_HANDOVER_TTL_MS,
  pruneOldLinks,
  replaceInviteToken,
} from '../src/modules/auth/links.js';
import { createDbTestEnv, type DbTestEnv } from './helpers.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const EMAIL = 'ana@club.example';

describe('links por propósito', () => {
  let env: DbTestEnv;

  beforeAll(async () => {
    env = await createDbTestEnv();
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await env.reset();
  });

  const at = (ms: number) => new Date(env.clock.now().getTime() + ms);
  const count = async () => (await env.db.query('SELECT 1 FROM login_tokens')).length;

  it('cada propósito tiene su vencimiento: 15 minutos para acceso y recuperación, 72 horas para la invitación', () => {
    expect(LINK_TTL_MS.access).toBe(15 * MINUTE);
    expect(LINK_TTL_MS.password_reset).toBe(15 * MINUTE);
    expect(LINK_TTL_MS.admin_invite).toBe(72 * HOUR);
  });

  it('los links de acceso y de recuperación siguen venciendo a los 15 minutos', async () => {
    for (const purpose of ['access', 'password_reset'] as const) {
      const vigente = await createLoginToken(env.db, purpose, EMAIL, env.clock.now());
      const vencido = await createLoginToken(env.db, purpose, EMAIL, env.clock.now());

      expect(await consumeLoginToken(env.db, purpose, vigente, at(14 * MINUTE))).toEqual({ ok: true, email: EMAIL });
      expect(await consumeLoginToken(env.db, purpose, vencido, at(15 * MINUTE + 1000))).toEqual({ ok: false, reason: 'expired' });
    }
  });

  it('un link de acceso con vencimiento propio (72 horas) sirve a las 71 y no a las 73, y sin él sigue en 15 minutos', async () => {
    const largo = await createLoginToken(env.db, 'access', EMAIL, env.clock.now(), PLAYER_HANDOVER_TTL_MS);
    const largoTarde = await createLoginToken(env.db, 'access', EMAIL, env.clock.now(), PLAYER_HANDOVER_TTL_MS);
    const corto = await createLoginToken(env.db, 'access', EMAIL, env.clock.now());

    expect(PLAYER_HANDOVER_TTL_MS).toBe(72 * HOUR);
    expect(await consumeLoginToken(env.db, 'access', largo, at(71 * HOUR))).toEqual({ ok: true, email: EMAIL });
    expect(await consumeLoginToken(env.db, 'access', largoTarde, at(73 * HOUR))).toEqual({ ok: false, reason: 'expired' });
    expect(await consumeLoginToken(env.db, 'access', corto, at(16 * MINUTE))).toEqual({ ok: false, reason: 'expired' });
  });

  it('la invitación vale 72 horas: sirve a las 71 y no a las 73', async () => {
    const vigente = await createLoginToken(env.db, 'admin_invite', EMAIL, env.clock.now());
    const tarde = await replaceInviteToken(env.db, 'otro@club.example', env.clock.now());

    expect(await consumeLoginToken(env.db, 'admin_invite', vigente, at(71 * HOUR))).toEqual({ ok: true, email: EMAIL });
    expect(await consumeLoginToken(env.db, 'admin_invite', tarde, at(73 * HOUR))).toEqual({ ok: false, reason: 'expired' });
  });

  it('un link de invitación usado se informa como usado', async () => {
    const token = await createLoginToken(env.db, 'admin_invite', EMAIL, env.clock.now());
    await consumeLoginToken(env.db, 'admin_invite', token, at(HOUR));
    expect(await consumeLoginToken(env.db, 'admin_invite', token, at(2 * HOUR))).toEqual({ ok: false, reason: 'used' });
  });

  it('una invitación de 48 horas sobrevive a la poda de links viejos', async () => {
    const token = await createLoginToken(env.db, 'admin_invite', EMAIL, env.clock.now());
    await pruneOldLinks(env.db, at(48 * HOUR));
    expect(await count()).toBe(1);
    expect(await consumeLoginToken(env.db, 'admin_invite', token, at(48 * HOUR))).toEqual({ ok: true, email: EMAIL });
  });

  it('la poda borra los links que vencieron hace más de un día, de cualquier propósito', async () => {
    await createLoginToken(env.db, 'access', EMAIL, env.clock.now()); // vence a los 15 minutos
    await createLoginToken(env.db, 'admin_invite', EMAIL, env.clock.now()); // vence a las 72 horas

    await pruneOldLinks(env.db, at(25 * HOUR)); // el de acceso venció hace más de 24 horas; la invitación sigue
    expect(await env.db.query(`SELECT purpose FROM login_tokens`)).toEqual([{ purpose: 'admin_invite' }]);

    await pruneOldLinks(env.db, at(72 * HOUR + 25 * HOUR)); // la invitación venció hace más de un día
    expect(await count()).toBe(0);
  });

  it('un link de un propósito no sirve para otro y no se consume al probarlo', async () => {
    const invite = await createLoginToken(env.db, 'admin_invite', EMAIL, env.clock.now());
    const reset = await createLoginToken(env.db, 'password_reset', EMAIL, env.clock.now());
    const access = await createLoginToken(env.db, 'access', EMAIL, env.clock.now());

    expect(await consumeLoginToken(env.db, 'password_reset', invite, at(MINUTE))).toMatchObject({ ok: false, reason: 'expired' });
    expect(await consumeLoginToken(env.db, 'access', invite, at(MINUTE))).toMatchObject({ ok: false, reason: 'expired' });
    expect(await consumeLoginToken(env.db, 'admin_invite', reset, at(MINUTE))).toMatchObject({ ok: false, reason: 'expired' });
    expect(await consumeLoginToken(env.db, 'admin_invite', access, at(MINUTE))).toMatchObject({ ok: false, reason: 'expired' });

    // Ninguno se gastó: cada uno sigue sirviendo para lo suyo.
    expect(await consumeLoginToken(env.db, 'admin_invite', invite, at(MINUTE))).toMatchObject({ ok: true });
    expect(await consumeLoginToken(env.db, 'password_reset', reset, at(MINUTE))).toMatchObject({ ok: true });
    expect(await consumeLoginToken(env.db, 'access', access, at(MINUTE))).toMatchObject({ ok: true });
  });

  it('reenviar deja vivo solo el link nuevo: el viejo se informa como vencido', async () => {
    const viejo = await replaceInviteToken(env.db, EMAIL, env.clock.now());
    const nuevo = await replaceInviteToken(env.db, EMAIL.toUpperCase(), env.clock.now());

    expect(await consumeLoginToken(env.db, 'admin_invite', viejo, at(MINUTE))).toEqual({ ok: false, reason: 'expired' });
    expect(await consumeLoginToken(env.db, 'admin_invite', nuevo, at(MINUTE))).toMatchObject({ ok: true });
  });

  it('reenviar no toca las invitaciones de otro mail ni los links de otro propósito', async () => {
    const otro = await replaceInviteToken(env.db, 'otro@club.example', env.clock.now());
    const reset = await createLoginToken(env.db, 'password_reset', EMAIL, env.clock.now());
    await replaceInviteToken(env.db, EMAIL, env.clock.now());

    expect(await consumeLoginToken(env.db, 'admin_invite', otro, at(MINUTE))).toMatchObject({ ok: true });
    expect(await consumeLoginToken(env.db, 'password_reset', reset, at(MINUTE))).toMatchObject({ ok: true });
  });

  it('hasLiveInvite distingue una invitación vigente de una vencida o usada', async () => {
    expect(await hasLiveInvite(env.db, EMAIL, env.clock.now())).toBe(false);
    const token = await replaceInviteToken(env.db, EMAIL, env.clock.now());
    expect(await hasLiveInvite(env.db, EMAIL, at(HOUR))).toBe(true);
    expect(await hasLiveInvite(env.db, EMAIL, at(73 * HOUR))).toBe(false);
    await consumeLoginToken(env.db, 'admin_invite', token, at(HOUR));
    expect(await hasLiveInvite(env.db, EMAIL, at(2 * HOUR))).toBe(false);
  });
});
