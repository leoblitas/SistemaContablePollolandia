// Ejecutar con:  npm test   (o: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { ica, icl, pmf, rinc, evaluar } = require('../lib/kpis');

const clase = (cod, v) => evaluar(cod, v).clasificacion;

test('ICA: Bueno < 2,00 · Normal 2,00–2,10 · Malo > 2,10', () => {
  assert.equal(ica(14700, 7566).toFixed(3), '1.943');
  assert.equal(clase('ICA', 1.99), 'BUENO');
  assert.equal(clase('ICA', 2.0), 'NORMAL');
  assert.equal(clase('ICA', 2.1), 'NORMAL');
  assert.equal(clase('ICA', 2.1001), 'MALO');
});

test('ICL: Bueno < 61 % · Normal 61–63 % · Malo > 63 %', () => {
  assert.equal(icl(60, 100), 60);
  assert.equal(clase('ICL', 60.99), 'BUENO');
  assert.equal(clase('ICL', 61), 'NORMAL');
  assert.equal(clase('ICL', 63), 'NORMAL');
  assert.equal(clase('ICL', 63.01), 'MALO');
});

test('PMF: Bueno < 10 % · Normal 10–20 % · Malo > 20 %', () => {
  assert.equal(pmf(1000, 920), 8);
  assert.equal(clase('PMF', 9.99), 'BUENO');
  assert.equal(clase('PMF', 10), 'NORMAL');
  assert.equal(clase('PMF', 20), 'NORMAL');
  assert.equal(clase('PMF', 20.01), 'MALO');
  assert.equal(evaluar('PMF', 8).provisional, true);
});

test('RINC: Malo < 5 % · Normal 5–14 % · Bueno ≥ 15 % (meta)', () => {
  assert.equal(rinc(5, 10, 100), 15);
  assert.equal(clase('RINC', 4.99), 'MALO');
  assert.equal(clase('RINC', 5), 'NORMAL');
  assert.equal(clase('RINC', 14.5), 'NORMAL'); // el documento no define 14–15 %: se trata como Normal
  assert.equal(clase('RINC', 15), 'BUENO');
});

test('Sin denominador no se inventa un valor', () => {
  for (const v of [ica(10, 0), icl(10, 0), pmf(0, 0), rinc(1, 1, 0)]) assert.equal(v, null);
  assert.equal(evaluar('ICL', null).clasificacion, 'SIN_DATOS');
});
