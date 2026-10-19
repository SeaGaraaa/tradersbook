// Настройки приложения. Секретов здесь нет: доступ к данным даёт только вход в Google-аккаунт.
export const CONFIG = {
  // OAuth Client ID (тип «Web application») из Google Cloud Console, проект trading-511922.
  clientId: "610068753148-8k4nu780sa73a04nho61elscdcre1qg5.apps.googleusercontent.com",
  // Таблица владельца: открывается только его аккаунтам (SHA-256 адресов ниже), остальным создаётся своя.
  spreadsheetId: "1XO5CnMMt6SDNxTO3R1rtAJL9u9pAOIrt6KK_JgEM_B4",
  ownerEmailSha256: [
    "2801c14933bbd50afee7e2e4c177980c0e618c6a3d50b6f59a27e57089ee6b2f",
    "3a252a54402d016df8d1a410e6c9712119ce50f54ceb684e9cdbfd9c14825d5e",
  ],
  journalSheet: "Journal",
  dashboardSheet: "Dashboard (копия)",
  // Лист бэктестов (создаётся сам при первой сделке бэктеста).
  backtestSheet: "Backtest",
  // Пройденные чек-листы (вкладка «Чек-лист»; лист создаётся сам при первом сохранении).
  checklistsSheet: "Checklists",
  // Торговая стратегия пользователя (вкладка «Стратегия»; лист создаётся сам при первом сохранении).
  strategySheet: "Strategy",
  // Лист со списками POI, Entry и Idea (создаётся сам при первой правке списков в приложении).
  listsSheet: "Lists",
  // Папка в Google Drive для скриншотов (создаётся сама).
  driveFolder: "Trading Journal",
};
