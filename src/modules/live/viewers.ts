/** Cuenta los espectadores simultáneos de la cámara y aplica el tope. */
export class ViewerCounter {
  private current = 0;

  constructor(private readonly max: number) {}

  get count(): number {
    return this.current;
  }

  /** Reserva un cupo. Devuelve una función que lo libera (solo la primera vez) o null si se alcanzó el tope. */
  acquire(): (() => void) | null {
    if (this.current >= this.max) return null;
    this.current += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.current -= 1;
    };
  }
}
