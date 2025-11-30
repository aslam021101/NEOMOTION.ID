import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";
import { getStorage } from "firebase/storage";

// TODO: Replace with your Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyAprtPLZIm__9yazoqvzENY3UpVqBcAm4I",
  authDomain: "haloinkubator-89a07.firebaseapp.com",
  databaseURL:
    "https://haloinkubator-89a07-default-rtdb.firebaseio.com",
  projectId: "haloinkubator-89a07",
  storageBucket: "haloinkubator-89a07.firebasestorage.app",
  messagingSenderId: "400649240712",
  appId: "1:400649240712:web:70c4db41364a10651cdf3d",
  measurementId: "G-HXDD5B4SQD",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
export const storage = getStorage(app);