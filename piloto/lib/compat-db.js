'use strict';
/**
 * lib/compat-db.js — adaptador mínimo para que los módulos escritos contra better-sqlite3
 * (accountingService, reportService) funcionen sobre `node:sqlite` (DatabaseSync), sin dependencias.
 * Solo agrega lo que esos módulos usan: db.transaction(fn) y db.pragma().
 */
function adaptar(db) {
  if (typeof db.transaction !== 'function') {
    db.transaction = (fn) => (...args) => {
      if (db.isTransaction) return fn(...args);          // ya hay una transacción abierta: se une a ella
      db.exec('BEGIN');
      try { const r = fn(...args); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    };
  }
  if (typeof db.pragma !== 'function') {
    db.pragma = (txt) => {
      const filas = db.prepare(`PRAGMA ${txt}`).all();
      return filas;
    };
  }
  return db;
}
module.exports = { adaptar };
