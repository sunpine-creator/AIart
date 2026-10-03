import React from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider, useStore } from './store';
import { StudentApp } from './screens/Student';
import { TeacherApp } from './screens/Teacher';
import './styles.css';

const isTeacherPath = () => location.pathname.startsWith('/teacher');

function TopBar() {
  const { s, d } = useStore();
  return (
    <div className="demobar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">OO 스튜디오</span>
        {isTeacherPath() && <span className="brand-tag">교사</span>}
      </div>
      {s.role === 'student' && (
        <button className="seg-b" onClick={() => d({ t: 'signOut' })}>
          나가기
        </button>
      )}
      {isTeacherPath() && s.role === 'teacher' && s.approvals.length > 0 && <span className="brand-tag">승인 대기 {s.approvals.length}</span>}
    </div>
  );
}

function App() {
  const { s } = useStore();
  return (
    <>
      <TopBar />
      {isTeacherPath() ? <TeacherApp /> : s.role === 'loading' ? null : <StudentApp />}
      {s.toast && (
        <div className="toast" role="status">
          {s.toast}
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StoreProvider>
    <App />
  </StoreProvider>,
);
