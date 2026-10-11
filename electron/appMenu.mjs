/**
 * 앱 메뉴 (2026-10-10 사용자 요청: ⌘Q를 눌러도 끄지 말고 메뉴바에 남기).
 * ⌘Q = 열린 창(설정·상태판)만 닫기. 진짜 종료는 상태판 '종료' 또는 ⌥⌘Q.
 * 편집 메뉴는 남긴다 — 없으면 설정 화면 입력 칸에서 복사·붙여넣기가 안 된다.
 */
export function appMenuTemplate({ onCloseWindows, onQuit }) {
  return [
    {
      label: 'Output',
      submenu: [
        { role: 'about', label: 'Output에 대하여' },
        { type: 'separator' },
        { label: '창 닫기 (메뉴바에 남음)', accelerator: 'CmdOrCtrl+Q', click: () => onCloseWindows() },
        { label: 'Output 종료', accelerator: 'Alt+CmdOrCtrl+Q', click: () => onQuit() },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
}
