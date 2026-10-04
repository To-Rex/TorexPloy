/**
 * Notification texts, per channel language. Kept short: a notification is
 * read on a phone lock screen, the details are one tap away in the panel.
 */
import type { Locale } from '@ploy/shared';

export interface MessageTexts {
  deploySucceeded: string;
  deployFailed: string;
  previousServing: string;
  appCrashed: string;
  crashedHint: string;
  backupFailed: string;
  serverOffline: string;
  serverRecovered: string;
  project: string;
  open: string;
  testTitle: string;
  testText: string;
  /** Localized reasons for the most common deployment failures; others fall back to the technical message. */
  reasons: Record<string, string>;
}

export const MESSAGES: Record<Locale, MessageTexts> = {
  uz: {
    deploySucceeded: '✅ {app}: yangi versiya ishga tushdi',
    deployFailed: '❌ {app}: joylashtirish muvaffaqiyatsiz tugadi',
    previousServing: 'Oldingi versiya ishlashda davom etmoqda.',
    appCrashed: '⚠️ {app}: konteyner qayta-qayta toʻxtab qolmoqda',
    crashedHint: 'Sababini ilova loglarida koʻring.',
    backupFailed: '❌ {service}: zaxira nusxa olinmadi',
    serverOffline: '🔌 {server} serveri bilan aloqa uzildi',
    serverRecovered: '✅ {server} serveri yana aloqada',
    project: 'Loyiha: {project}',
    open: 'Panelda ochish',
    testTitle: '🔔 TorexPloy: sinov xabari',
    testText: 'Bu kanal ishlayapti. Tanlangan hodisalar haqida xabarlar shu yerga keladi.',
    reasons: {
      build_failed: 'Yigʻish muvaffaqiyatsiz tugadi.',
      build_timeout: 'Yigʻish vaqt chegarasidan oshib ketdi.',
      health_timeout: 'Ilova belgilangan vaqtda javob bermadi.',
      crash: 'Ilova ishga tushish paytida toʻxtab qoldi.',
      oom: 'Ilovaga xotira yetmadi.',
      pull_failed: 'Image’ni yuklab boʻlmadi.',
      git: 'Repozitoriyadan kodni olib boʻlmadi.',
      git_auth: 'Repozitoriyaga kirish rad etildi.',
      git_branch: 'Branch topilmadi.',
      server_not_ready: 'Server tayyor emas.',
      docker_unreachable: 'Docker’ga ulanib boʻlmadi.',
      proxy: 'Trafikni yangi versiyaga oʻtkazib boʻlmadi.',
      interrupted: 'Boshqaruv serveri qayta ishga tushdi.',
    },
  },
  ru: {
    deploySucceeded: '✅ {app}: новая версия запущена',
    deployFailed: '❌ {app}: развёртывание не удалось',
    previousServing: 'Предыдущая версия продолжает работать.',
    appCrashed: '⚠️ {app}: контейнер постоянно падает',
    crashedHint: 'Причина — в логах приложения.',
    backupFailed: '❌ {service}: резервная копия не создана',
    serverOffline: '🔌 Сервер {server} перестал отвечать',
    serverRecovered: '✅ Сервер {server} снова на связи',
    project: 'Проект: {project}',
    open: 'Открыть в панели',
    testTitle: '🔔 TorexPloy: тестовое сообщение',
    testText: 'Канал работает. Уведомления о выбранных событиях будут приходить сюда.',
    reasons: {
      build_failed: 'Сборка завершилась ошибкой.',
      build_timeout: 'Сборка превысила лимит времени.',
      health_timeout: 'Приложение не ответило вовремя.',
      crash: 'Приложение упало при запуске.',
      oom: 'Приложению не хватило памяти.',
      pull_failed: 'Не удалось скачать образ.',
      git: 'Не удалось получить код из репозитория.',
      git_auth: 'Доступ к репозиторию запрещён.',
      git_branch: 'Ветка не найдена.',
      server_not_ready: 'Сервер не готов.',
      docker_unreachable: 'Не удалось подключиться к Docker.',
      proxy: 'Не удалось переключить трафик на новую версию.',
      interrupted: 'Управляющий сервер перезапустился.',
    },
  },
  en: {
    deploySucceeded: '✅ {app}: new version is live',
    deployFailed: '❌ {app}: deployment failed',
    previousServing: 'The previous version keeps serving.',
    appCrashed: '⚠️ {app}: the container keeps crashing',
    crashedHint: 'The cause is in the app logs.',
    backupFailed: '❌ {service}: backup failed',
    serverOffline: '🔌 Server {server} stopped responding',
    serverRecovered: '✅ Server {server} is back',
    project: 'Project: {project}',
    open: 'Open in the panel',
    testTitle: '🔔 TorexPloy: test message',
    testText: 'This channel works. Notifications for the selected events will arrive here.',
    reasons: {
      build_failed: 'The build failed.',
      build_timeout: 'The build ran out of time.',
      health_timeout: 'The app did not respond in time.',
      crash: 'The app crashed while starting.',
      oom: 'The app ran out of memory.',
      pull_failed: 'The image could not be pulled.',
      git: 'The code could not be fetched from the repository.',
      git_auth: 'Access to the repository was denied.',
      git_branch: 'The branch was not found.',
      server_not_ready: 'The server is not ready.',
      docker_unreachable: 'Docker is not reachable.',
      proxy: 'Traffic could not be switched to the new version.',
      interrupted: 'The control plane restarted.',
    },
  },
};

export function fill(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => params[key] ?? match);
}
