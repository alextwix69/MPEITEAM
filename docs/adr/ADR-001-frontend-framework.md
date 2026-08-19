# ADR-001: Frontend framework

Статус: принято.
Дата: 19.08.2026.

## Контекст

MVP имеет один закрытый web client, русскоязычный адаптивный UI и realtime-подсказки. SEO не является основной ценностью. Команде нужен распространённый TypeScript-стек без отдельного BFF и без двух независимых моделей клиентского состояния.

## Решение

Использовать Next.js App Router, React и TypeScript strict. TanStack Query владеет server state, React Hook Form и Zod — формами, Tailwind CSS и shadcn/ui — presentation layer. REST `/api/v1` является источником истины; Socket.IO только инвалидирует/обновляет query state. Глобальный Redux-store и отдельный BFF не вводятся.

## Альтернативы

- SPA на Vite: проще runtime, но отклоняется от утверждённого baseline и теряет единый routing/rendering framework.
- GraphQL/BFF: оправданы несколькими разнородными клиентами, которых в MVP нет.
- Redux: не нужен при разделении server state и локального UI state.

## Последствия

- Frontend зависит от стабильности REST DTO; ADR-008 задаёт compatibility gate.
- Бизнес-правила и авторизация не переносятся в Server Components.
- Основные journeys проверяются Playwright на desktop/mobile, с клавиатурой и поддерживаемыми браузерами.

## Триггер пересмотра

Появление второго независимого клиента, доказанная необходимость BFF или систематическая невозможность собрать экран без чрезмерного числа API-запросов.
