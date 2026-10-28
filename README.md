# JS Quest

Навчальна гра з JavaScript на Next.js. Гравець пише команди для робота, проходить сім рівнів і зберігає прогрес у браузері.

## Локальний запуск

Потрібні Node.js 20.9 або новіший та npm.

1. Встановіть залежності:

   ```bash
   npm ci
   ```

2. Скопіюйте `.env.example` у `.env.local` і вставте ключі застосунку Clerk:

   ```dotenv
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
   CLERK_SECRET_KEY=sk_test_...
   ```

3. Запустіть застосунок:

   ```bash
   npm run dev
   ```

Після цього відкрийте [http://localhost:3000](http://localhost:3000).

Не додавайте `.env.local` або справжні секретні ключі до репозиторію.

## Перевірки

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm audit
```

Код, який вводить гравець, виконується в окремому Web Worker з обмеженнями часу й кількості операцій. Для файлу виконавця застосовується окрема Content Security Policy, яка забороняє мережеві з'єднання.
