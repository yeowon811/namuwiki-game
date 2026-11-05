// Firebase 콘솔 → 프로젝트 설정 → 내 앱(웹)에 나오는 값입니다.
// 웹 앱의 apiKey는 비밀번호가 아니라 프로젝트를 식별하는 값이라 공개 저장소에 올려도 괜찮습니다.
// 실제 보안은 Realtime Database 규칙(database.rules.json)으로 지킵니다.
export const firebaseConfig = {
  apiKey: 'AIzaSyBJw4YHGxwRFsm5CMeYZn1KuXdl_18EEss',
  authDomain: 'namuwiki-game.firebaseapp.com',
  databaseURL: 'https://namuwiki-game-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'namuwiki-game',
  storageBucket: 'namuwiki-game.firebasestorage.app',
  messagingSenderId: '61635410860',
  appId: '1:61635410860:web:50e2f40a33f92858cf5809',
  measurementId: 'G-SGTB0GVP35',
};
