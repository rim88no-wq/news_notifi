'use strict';
// Initializes Firebase using the browser compat SDK (loaded via CDN in HTML)
(function () {
  const config = {
    apiKey:            'AIzaSyAP-mAd3vMhgnJ5LK7jCKXOYs3CdN78Il0',
    authDomain:        'website-news-65a8c.firebaseapp.com',
    projectId:         'website-news-65a8c',
    storageBucket:     'website-news-65a8c.firebasestorage.app',
    messagingSenderId: '261383476897',
    appId:             '1:261383476897:web:436430a234305b9f9482e0',
  };
  if (!firebase.apps.length) firebase.initializeApp(config);
  window.db = firebase.firestore();
})();
