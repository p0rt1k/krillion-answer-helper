import prisma from './db/prisma'
import { Prisma } from './generated/prisma/client'
import { Mutex } from 'async-mutex'

const mutex = new Mutex()

export async function getAllPrompts() {
  return prisma.prompt.findMany({ where: { cat: { not: null } } })
}

export async function addPrompts(prompts: Prisma.promptCreateManyInput[]) {
  console.debug(prompts)
  prisma.$transaction(async (tx) => {
    await tx.prompt.deleteMany({ where: { id: { in: prompts.map((x) => x.id) } } })
    return tx.prompt.createMany({ data: prompts, skipDuplicates: true })
  })
}

export async function addAnswers(answers: Prisma.answerCreateManyInput[]) {
  const release = await mutex.acquire()
  try {
    await prisma.answer.createMany({ data: answers, skipDuplicates: true })
  } finally {
    release()
  }
}
