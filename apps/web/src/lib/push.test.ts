import { describe, expect, it } from 'vitest';
import { urlBase64ToBytes } from './push';

describe('urlBase64ToBytes', () => {
  it('decodes base64url with and without padding', () => {
    // "hello?>" -> aGVsbG8_Pg in base64url (uses _ for /)
    expect([...urlBase64ToBytes('aGVsbG8_Pg')]).toEqual([...'hello?>'].map((c) => c.charCodeAt(0)));
    expect([...urlBase64ToBytes('AQID')]).toEqual([1, 2, 3]);
  });

  it('turns - and _ into the standard alphabet', () => {
    expect([...urlBase64ToBytes('-_8')]).toEqual([251, 255]);
  });
});
