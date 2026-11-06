import { describe, expect, it } from 'vitest';
import { ViewerCounter } from '../src/modules/live/viewers.js';

describe('ViewerCounter', () => {
  it('acepta hasta el tope', () => {
    const counter = new ViewerCounter(2);
    expect(counter.acquire()).not.toBeNull();
    expect(counter.acquire()).not.toBeNull();
    expect(counter.count).toBe(2);
  });

  it('rechaza al excedente', () => {
    const counter = new ViewerCounter(1);
    counter.acquire();
    expect(counter.acquire()).toBeNull();
    expect(counter.count).toBe(1);
  });

  it('libera el cupo y permite que entre uno nuevo', () => {
    const counter = new ViewerCounter(1);
    const release = counter.acquire()!;
    expect(counter.acquire()).toBeNull();
    release();
    expect(counter.count).toBe(0);
    expect(counter.acquire()).not.toBeNull();
  });

  it('liberar dos veces no libera cupos ajenos', () => {
    const counter = new ViewerCounter(2);
    const a = counter.acquire()!;
    counter.acquire();
    a();
    a();
    a();
    expect(counter.count).toBe(1);
  });
});
