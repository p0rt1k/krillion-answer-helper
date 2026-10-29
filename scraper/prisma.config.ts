import path from 'path'
import dotenv from 'dotenv'
// eslint-disable-next-line import/no-extraneous-dependencies
import { defineConfig } from 'prisma/config'

dotenv.config({ path: path.resolve(__dirname, '../.env') })

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations'
  },
  datasource: {
    url: process.env.DATABASE_URL
  }
})
