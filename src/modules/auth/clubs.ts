/**
 * Clubes válidos para un admin.
 * Copia de los ids de `MOCK_COMPLEXES` en `frontend2/src/data/mockComplexes.ts`: los clubes
 * siguen siendo datos de ejemplo del frontend. Si cambian allá, hay que cambiarlos acá.
 * Esta lista desaparece cuando los clubes pasen a la base.
 */
export const DEMO_CLUB_IDS = [
  'estacion-norte',
  'la-cantera-crespo',
  'polideportivo-belgrano',
  'parque-sur-caballito',
  'arena-nunez',
  'terraza-colegiales',
] as const;

export function isDemoClubId(id: string): boolean {
  return (DEMO_CLUB_IDS as readonly string[]).includes(id);
}
