-- DropForeignKey
ALTER TABLE "answer" DROP CONSTRAINT "answer_promptId_fkey";

-- AddForeignKey
ALTER TABLE "answer" ADD CONSTRAINT "answer_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
