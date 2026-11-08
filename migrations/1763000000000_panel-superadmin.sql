-- Up Migration

-- Rol de plataforma: el superadmin no pertenece a ningún club y siempre tiene contraseña.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('player', 'club_admin', 'superadmin'));

-- Forma de cada rol. Un club_admin necesita club pero puede NO tener contraseña todavía: es el admin invitado,
-- que la elige con el link del mail. El login lo trata como credencial inválida mientras no la tenga.
ALTER TABLE users DROP CONSTRAINT users_club_admin_needs_club_and_password;
ALTER TABLE users ADD CONSTRAINT users_role_shape_check CHECK (
  role = 'player'
  OR (role = 'club_admin' AND club_id IS NOT NULL)
  OR (role = 'superadmin' AND club_id IS NULL AND password_hash IS NOT NULL)
);

-- Baja lógica de admins: la cuenta se conserva, pero no puede ingresar ni recuperar su contraseña.
ALTER TABLE users ADD COLUMN deactivated_at timestamptz NULL;

-- Estado del club: uno desactivado no se muestra en el sitio, pero conserva sus canchas y sus admins.
ALTER TABLE clubs ADD COLUMN active boolean NOT NULL DEFAULT true;

-- Las invitaciones de admin son un tercer tipo de link, con vencimiento y límite propios.
ALTER TABLE login_tokens DROP CONSTRAINT login_tokens_purpose_check;
ALTER TABLE login_tokens ADD CONSTRAINT login_tokens_purpose_check
  CHECK (purpose IN ('access', 'password_reset', 'admin_invite'));
ALTER TABLE link_requests DROP CONSTRAINT link_requests_purpose_check;
ALTER TABLE link_requests ADD CONSTRAINT link_requests_purpose_check
  CHECK (purpose IN ('access', 'password_reset', 'admin_invite'));

-- Down Migration

-- OJO: esta vuelta atrás FALLA si ya existen superadmins o admins invitados sin contraseña.
-- Hay que borrarlos (o completarles la contraseña) antes de revertir.
DELETE FROM login_tokens WHERE purpose = 'admin_invite';
DELETE FROM link_requests WHERE purpose = 'admin_invite';
ALTER TABLE link_requests DROP CONSTRAINT link_requests_purpose_check;
ALTER TABLE link_requests ADD CONSTRAINT link_requests_purpose_check CHECK (purpose IN ('access', 'password_reset'));
ALTER TABLE login_tokens DROP CONSTRAINT login_tokens_purpose_check;
ALTER TABLE login_tokens ADD CONSTRAINT login_tokens_purpose_check CHECK (purpose IN ('access', 'password_reset'));

ALTER TABLE clubs DROP COLUMN active;
ALTER TABLE users DROP COLUMN deactivated_at;

ALTER TABLE users DROP CONSTRAINT users_role_shape_check;
ALTER TABLE users ADD CONSTRAINT users_club_admin_needs_club_and_password
  CHECK (role <> 'club_admin' OR (club_id IS NOT NULL AND password_hash IS NOT NULL));
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('player', 'club_admin'));
