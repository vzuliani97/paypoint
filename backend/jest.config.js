/** @type {import('jest').Config} */
const shared = {
  preset: 'ts-jest',
  testEnvironment: 'node',
};

module.exports = {
  projects: [
    {
      ...shared,
      displayName: 'unit',
      testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
    },
    {
      ...shared,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
      setupFiles: ['<rootDir>/test/e2e/env.ts'],
    },
  ],
};
