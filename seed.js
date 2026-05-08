'use strict';

const { db } = require('./firebase');
const { collection, doc, getDocs, setDoc, deleteDoc } = require('firebase/firestore');
const fs   = require('fs');
const path = require('path');

const FORCE = process.argv.includes('--force');

async function seedCollection(name, jsonFile) {
  const filePath = path.join(__dirname, 'data', jsonFile);

  if (!fs.existsSync(filePath)) {
    console.log(`⏭  Skipping ${name} — ${jsonFile} not found`);
    return;
  }

  const records  = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const existing = await getDocs(collection(db, name));

  if (!existing.empty && !FORCE) {
    console.log(`⏭  ${name}: already has ${existing.size} record(s). Use --force to overwrite.`);
    return;
  }

  // Delete all existing docs first so stale records are removed
  if (!existing.empty) {
    await Promise.all(existing.docs.map((d) => deleteDoc(d.ref)));
    console.log(`🗑  ${name}: deleted ${existing.size} stale record(s)`);
  }

  await Promise.all(
    records.map((record) => setDoc(doc(db, name, record.id), record))
  );
  console.log(`✅ ${name}: seeded ${records.length} record(s)`);
}

async function main() {
  console.log('🌱  Seeding Cloud Firestore…\n');

  await seedCollection('articles',      'articles.json');
  await seedCollection('notifications', 'notifications.json');

  // subscriptions are push-subscription objects from browsers — not seeded from file
  console.log('\n✅  Database ready. subscriptions collection is managed at runtime.');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌  Seed failed:', err.message);
  process.exit(1);
});
