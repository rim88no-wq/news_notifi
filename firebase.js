'use strict';

const { initializeApp, getApps } = require('firebase/app');
const { getFirestore }           = require('firebase/firestore');

const firebaseConfig = {
  apiKey:            'AIzaSyAP-mAd3vMhgnJ5LK7jCKXOYs3CdN78Il0',
  authDomain:        'website-news-65a8c.firebaseapp.com',
  projectId:         'website-news-65a8c',
  storageBucket:     'website-news-65a8c.firebasestorage.app',
  messagingSenderId: '261383476897',
  appId:             '1:261383476897:web:436430a234305b9f9482e0',
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const db  = getFirestore(app);

module.exports = { db };
