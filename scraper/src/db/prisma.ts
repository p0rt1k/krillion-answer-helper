import path from 'path'
import dotenv from 'dotenv'
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client'

// Resolves to repo root from both src/db and build/db
dotenv.config({ path: path.resolve(__dirname, '../../../.env') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
})

const adapter = new PrismaPg(pool)

const prisma = new PrismaClient({ adapter })

export default prisma
