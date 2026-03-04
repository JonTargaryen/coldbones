/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        // relax for tests
        strict: false,
        noImplicitAny: false,
        skipLibCheck: true,
      },
    }],
  },
  collectCoverageFrom: [
    'lib/**/*.ts',
    'constructs/**/*.ts',
    'bin/**/*.ts',
    '!**/*.d.ts',
  ],
  coverageThreshold: {
    global: {
      lines: 70,
      functions: 70,
      statements: 70,
    },
  },
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout: 30000,
};
