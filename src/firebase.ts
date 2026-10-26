import { initializeApp } from 'firebase/app'
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { connectStorageEmulator, getStorage } from 'firebase/storage'
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore'

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
})

export const auth = getAuth(app)

// Offline cache keeps worklists usable on a flaky lab connection.
// Named database 'health-care-labs' (asia-south1). VITE_FIRESTORE_DB overrides it if ever needed.
export const FIRESTORE_DB = import.meta.env.VITE_FIRESTORE_DB || 'health-care-labs'
export const db = initializeFirestore(
  app,
  { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) },
  FIRESTORE_DB,
)

// File storage: collection photos, report PDFs, attachments, radiology images.
export const storage = getStorage(app)

// Cloud Functions in Mumbai, close to the data.
export const functions = getFunctions(app, 'asia-south1')

if (import.meta.env.VITE_USE_EMULATORS === 'true') {
  connectFunctionsEmulator(functions, '127.0.0.1', 5001)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  connectStorageEmulator(storage, '127.0.0.1', 9199)
}

// Single-organisation deployment: every document lives under one lab.
export const LAB_ID = import.meta.env.VITE_LAB_ID || 'main'
