import assert from 'node:assert/strict';
import test from 'node:test';
import { brandName } from '../src/desk/brands';

test('brand-name coins: the 5 Oct names are caught, misspellings too; real projects and ordinary words are not', () => {
  for (const [name, symbol, brand] of [['Addidas', 'Addidas', 'Adidas'], ['NVIDIA', 'NVIDIA', 'NVIDIA'], ['AAPLE AI', 'AAPLE', 'Apple'], ['Grok AI', 'GROK', 'xAI'],
    ['Gemini', 'GEMINI', 'Google'], ['Claude AI', 'CLAUDE', 'Anthropic'], ['NvidiaAI', 'NVAI', 'NVIDIA'], ['Tesla Bot', 'TBOT', 'Tesla']] as const)
    assert.match(brandName(name, symbol) ?? '', new RegExp(`names ${brand}, a real company`), name);
  for (const [name, symbol] of [['ReservePad', 'RESERVE'], ['Finance', 'FIN'], ['Phone', 'PHONE'], ['Metal', 'METAL'], ['Pineapple', 'PINE'], ['Über', 'UBER'],
    ['Spaces', 'SPACE'], ['Catoppy', 'Catoppy'], ['Come as you Pump', 'COMEPUMP'], [null, null]] as const)
    assert.equal(brandName(name, symbol), null, String(name));
});
