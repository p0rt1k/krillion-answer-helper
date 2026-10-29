import { error } from 'node:console'
import prisma from './db/prisma'
import { Prisma } from './generated/prisma/client'
import { Mutex } from 'async-mutex'

const mutex = new Mutex()

export async function getAllPrompts() {
  return prisma.prompt.findMany({ where: { cat: { not: null }, answers: { none: { value: { gte: 4 } } } } })
}

export async function addPrompts(prompts: Prisma.promptCreateManyInput[]) {
  prisma.$transaction(async (tx) => {
    await tx.prompt.deleteMany({ where: { id: { in: prompts.map((x) => x.id) } } })
    return tx.prompt.createMany({ data: prompts, skipDuplicates: true })
  })
}

export async function addAnswers(answers: Prisma.answerCreateManyInput[]) {
  const release = await mutex.acquire()
  try {
    await prisma.answer.createMany({
      // PostgreSQL text columns cannot store NUL characters.
      data: answers
        .filter(
          (answer, index, self) =>
            index === self.findIndex((o) => o.promptId === answer.promptId && o.text === answer.text)
        )
        .map((answer) => ({ ...answer, text: answer.text.replace(/\u0000/g, '') })),
      skipDuplicates: true
    })
  } catch (error) {
    console.log(
      await prisma.answer.findMany({
        where: { promptId: answers[0].promptId, text: { in: answers.map((x) => x.text) } }
      })
    )
    console.error(error, answers)
  } finally {
    release()
  }
}
