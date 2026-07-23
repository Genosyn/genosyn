import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Postgres-stream sibling of the sqlite `RevenueSpine1784841570822` migration —
 * the thirteen Revenue (M32) tables: contacts, deal stages, deals, deal
 * contacts, activities, suppressions, sequences and their steps / enrollments /
 * step runs, signals, signal events, and the per-employee revenue grant.
 *
 * Generated against a real PostgreSQL 16 by pointing `config.db.driver` at it,
 * running the whole postgres chain from an empty database, and generating the
 * delta; a re-run of `migration:generate` afterwards reported no changes, so
 * this file is drift-free by construction rather than by transliteration. Only
 * the timestamp, class name, and this comment were edited afterwards, per the
 * sibling-pairing convention (sqlite timestamp + 1).
 */

export class RevenueSpine1784841570823 implements MigrationInterface {
    name = 'RevenueSpine1784841570823'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "contacts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "name" character varying NOT NULL, "email" character varying NOT NULL DEFAULT '', "phone" character varying NOT NULL DEFAULT '', "title" character varying NOT NULL DEFAULT '', "linkedinUrl" character varying NOT NULL DEFAULT '', "websiteUrl" character varying NOT NULL DEFAULT '', "customerId" character varying, "companyName" character varying NOT NULL DEFAULT '', "lifecycleStage" character varying NOT NULL DEFAULT 'lead', "ownerId" character varying, "ownerEmployeeId" character varying, "source" character varying NOT NULL DEFAULT '', "sourceDetail" character varying NOT NULL DEFAULT '', "score" integer NOT NULL DEFAULT '0', "enrichedJson" text, "notes" text NOT NULL DEFAULT '', "doNotContact" boolean NOT NULL DEFAULT false, "unsubscribedAt" TIMESTAMP WITH TIME ZONE, "bouncedAt" TIMESTAMP WITH TIME ZONE, "lastActivityAt" TIMESTAMP WITH TIME ZONE, "archivedAt" TIMESTAMP WITH TIME ZONE, "createdById" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b99cd40cfd66a99f1571f4f72e6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c45581301c84a8b96f4f5174cc" ON "contacts" ("companyId", "lastActivityAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_d321a5c3695ceb8ee8f5655988" ON "contacts" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_a4c488d49a53802623d18884fd" ON "contacts" ("companyId", "lifecycleStage") `);
        await queryRunner.query(`CREATE INDEX "IDX_38d8fa59e9edbde3bd66eb3d77" ON "contacts" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_fff8748b888856f6c7625cc11b" ON "contacts" ("companyId", "email") `);
        await queryRunner.query(`CREATE TABLE "deal_stages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "name" character varying NOT NULL, "slug" character varying NOT NULL, "sortOrder" integer NOT NULL DEFAULT '0', "probability" integer NOT NULL DEFAULT '0', "kind" character varying NOT NULL DEFAULT 'open', "color" character varying NOT NULL DEFAULT '', "description" text NOT NULL DEFAULT '', "archivedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_71da6c7a6f162f4d1b73a2c3bb3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_798eb7ffe0257287aee4db7770" ON "deal_stages" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_8f0ac964a423c9d8563ccfb148" ON "deal_stages" ("companyId", "sortOrder") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6096ae381257efae65adeca4e6" ON "deal_stages" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "deals" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "title" character varying NOT NULL, "description" text NOT NULL DEFAULT '', "customerId" character varying, "primaryContactId" character varying, "stageId" character varying NOT NULL, "amountCents" integer NOT NULL DEFAULT '0', "currency" character varying NOT NULL DEFAULT 'USD', "probabilityOverride" integer, "expectedCloseDate" TIMESTAMP WITH TIME ZONE, "status" character varying NOT NULL DEFAULT 'open', "closedAt" TIMESTAMP WITH TIME ZONE, "lostReason" character varying NOT NULL DEFAULT '', "source" character varying NOT NULL DEFAULT '', "ownerId" character varying, "ownerEmployeeId" character varying, "nextStep" character varying NOT NULL DEFAULT '', "lastActivityAt" TIMESTAMP WITH TIME ZONE, "archivedAt" TIMESTAMP WITH TIME ZONE, "createdById" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_8c66f03b250f613ff8615940b4b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_837b88803d23a79b88ebd9bd2c" ON "deals" ("companyId", "expectedCloseDate") `);
        await queryRunner.query(`CREATE INDEX "IDX_98de6ef1bebb17bb0b74cef931" ON "deals" ("companyId", "closedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_feb688fb4f152b0ca1228e449e" ON "deals" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_c419cf497b3eac82f1b6d653c7" ON "deals" ("companyId", "ownerEmployeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_251df647cb9cc143e2488db3a1" ON "deals" ("companyId", "primaryContactId") `);
        await queryRunner.query(`CREATE INDEX "IDX_be8282d6fa0ac87f2eb85b5d90" ON "deals" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_67282fe42388eefa1de17cb7de" ON "deals" ("companyId", "stageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_43ebfc877f6a4a18a232f6d7c9" ON "deals" ("companyId", "status") `);
        await queryRunner.query(`CREATE TABLE "deal_contacts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "dealId" character varying NOT NULL, "contactId" character varying NOT NULL, "role" character varying NOT NULL DEFAULT '', "sortOrder" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e5be20461b235feb7b347a803e6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0a808d4f61d0b204f3554367e4" ON "deal_contacts" ("dealId", "contactId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d09133ea83c39ca3ef9658df69" ON "deal_contacts" ("contactId") `);
        await queryRunner.query(`CREATE INDEX "IDX_3991be6470f78d56144b155bb5" ON "deal_contacts" ("dealId") `);
        await queryRunner.query(`CREATE TABLE "activities" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "kind" character varying NOT NULL, "subject" character varying NOT NULL DEFAULT '', "bodyText" text NOT NULL DEFAULT '', "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "contactId" character varying, "dealId" character varying, "customerId" character varying, "mailThreadId" character varying, "mailMessageId" character varying, "actorUserId" character varying, "actorEmployeeId" character varying, "metaJson" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_7f4004429f731ffb9c88eb486a8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_47d9a8dbb573521810a5b2c3dc" ON "activities" ("companyId", "mailMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_2bddf29f25d4a1752ea6eadc63" ON "activities" ("customerId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_0475b6d437b908dac4a4e768b5" ON "activities" ("dealId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_823726e0acc9be30241813fbf7" ON "activities" ("contactId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_5383feac2144f5b54f1ff44094" ON "activities" ("companyId", "kind") `);
        await queryRunner.query(`CREATE INDEX "IDX_94aa9cdb289d03202f0bf2bfef" ON "activities" ("companyId", "occurredAt") `);
        await queryRunner.query(`CREATE TABLE "suppressions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "email" character varying NOT NULL, "reason" character varying NOT NULL DEFAULT 'manual', "source" character varying NOT NULL DEFAULT '', "contactId" character varying, "notes" text NOT NULL DEFAULT '', "createdById" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_77bb19dbc77a4ce0ca8cb743f3b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_695cc5425122f2325b39544a7d" ON "suppressions" ("companyId", "reason") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2908e938bf40936ef6d3954470" ON "suppressions" ("companyId", "email") `);
        await queryRunner.query(`CREATE TABLE "sequences" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "name" character varying NOT NULL, "slug" character varying NOT NULL, "description" text NOT NULL DEFAULT '', "status" character varying NOT NULL DEFAULT 'draft', "mailAccountId" character varying NOT NULL, "employeeId" character varying NOT NULL, "brief" text NOT NULL DEFAULT '', "autoSend" boolean NOT NULL DEFAULT false, "stopOnReply" boolean NOT NULL DEFAULT true, "dailyCap" integer NOT NULL DEFAULT '50', "sendWindowJson" text, "archivedAt" TIMESTAMP WITH TIME ZONE, "createdById" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_7c7f5d8c822411196242b89bc76" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5218dd1caf9a9b1ed3b5ebaac5" ON "sequences" ("companyId", "employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_b158cdd1c39ffeb75863e7e2ba" ON "sequences" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0ada014ecbfc9ad7a0ef465821" ON "sequences" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "sequence_steps" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "sequenceId" character varying NOT NULL, "sortOrder" integer NOT NULL DEFAULT '0', "name" character varying NOT NULL DEFAULT '', "delayDays" integer NOT NULL DEFAULT '3', "delayHours" integer NOT NULL DEFAULT '0', "instruction" text NOT NULL DEFAULT '', "threadWithPrevious" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_73b25d9565a39e0f4be22901940" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_eb66c610eb3d96f66c35fa15a0" ON "sequence_steps" ("sequenceId", "sortOrder") `);
        await queryRunner.query(`CREATE TABLE "sequence_enrollments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "sequenceId" character varying NOT NULL, "contactId" character varying NOT NULL, "dealId" character varying, "status" character varying NOT NULL DEFAULT 'active', "currentStepOrder" integer NOT NULL DEFAULT '0', "nextRunAt" TIMESTAMP WITH TIME ZONE, "lastStepAt" TIMESTAMP WITH TIME ZONE, "stoppedReason" character varying NOT NULL DEFAULT '', "mailThreadId" character varying, "createdById" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_8dc3d240dd44d86a12fc1957708" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b7e47715956a46c3847ce5d891" ON "sequence_enrollments" ("mailThreadId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1587e1c3f169ceb2f148c31176" ON "sequence_enrollments" ("companyId", "contactId") `);
        await queryRunner.query(`CREATE INDEX "IDX_dbe0f6e04fd9d458c376c3a38c" ON "sequence_enrollments" ("status", "nextRunAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_a3a9b1a642dd42c58b5595640e" ON "sequence_enrollments" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d1ab86f9f16d30a2d05cb07177" ON "sequence_enrollments" ("sequenceId", "contactId") `);
        await queryRunner.query(`CREATE TABLE "sequence_step_runs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "sequenceId" character varying NOT NULL, "enrollmentId" character varying NOT NULL, "stepId" character varying NOT NULL, "stepOrder" integer NOT NULL DEFAULT '0', "status" character varying NOT NULL DEFAULT 'drafted', "mailMessageId" character varying, "mailThreadId" character varying, "detail" text NOT NULL DEFAULT '', "subject" character varying NOT NULL DEFAULT '', "ranAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_7821c356b8a1c5a02917626d4ad" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_87f64b3f848f52bf561bb5959b" ON "sequence_step_runs" ("enrollmentId", "stepId") `);
        await queryRunner.query(`CREATE INDEX "IDX_becc1908e607b73675b6e7f335" ON "sequence_step_runs" ("companyId", "ranAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_9d37ab4b5b9abc61a453654839" ON "sequence_step_runs" ("enrollmentId", "ranAt") `);
        await queryRunner.query(`CREATE TABLE "signals" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "name" character varying NOT NULL, "slug" character varying NOT NULL, "description" text NOT NULL DEFAULT '', "sourceKind" character varying NOT NULL DEFAULT 'sql', "connectionId" character varying, "sql" text NOT NULL DEFAULT '', "cron" character varying NOT NULL DEFAULT '0 * * * *', "enabled" boolean NOT NULL DEFAULT false, "dedupeKeyColumn" character varying NOT NULL DEFAULT '', "emailColumn" character varying NOT NULL DEFAULT '', "domainColumn" character varying NOT NULL DEFAULT '', "amountColumn" character varying NOT NULL DEFAULT '', "actionKind" character varying NOT NULL DEFAULT 'activity', "actionConfigJson" text, "employeeId" character varying, "lastRunAt" TIMESTAMP WITH TIME ZONE, "lastError" text NOT NULL DEFAULT '', "lastEventCount" integer NOT NULL DEFAULT '0', "archivedAt" TIMESTAMP WITH TIME ZONE, "createdById" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_04eeac09c09b65bc55c628c101d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cfb2c9fbdf16b78c560cfeab6b" ON "signals" ("companyId", "enabled") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8404eecc9e43e246ded04c5748" ON "signals" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "signal_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "signalId" character varying NOT NULL, "dedupeKey" character varying NOT NULL, "payloadJson" text, "contactId" character varying, "customerId" character varying, "dealId" character varying, "status" character varying NOT NULL DEFAULT 'new', "detail" text NOT NULL DEFAULT '', "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_8f67f64f50f7ac5b423c9f3dd25" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_875fc3d58f7b42b6e12b748301" ON "signal_events" ("contactId") `);
        await queryRunner.query(`CREATE INDEX "IDX_4958c9db662c0a6cd73aa55d2b" ON "signal_events" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_6233982303bb01ce3e1abfa67c" ON "signal_events" ("companyId", "occurredAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_012902809eb8aa97a5e678ab61" ON "signal_events" ("signalId", "dedupeKey") `);
        await queryRunner.query(`CREATE TABLE "employee_revenue_grants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "accessLevel" character varying NOT NULL DEFAULT 'read', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_563528d54b484c92fda94280ae5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ee79c9a39779ad3cc3814aee44" ON "employee_revenue_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_40b7d403db4ef96fa9bea5b55b" ON "employee_revenue_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_40b7d403db4ef96fa9bea5b55b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ee79c9a39779ad3cc3814aee44"`);
        await queryRunner.query(`DROP TABLE "employee_revenue_grants"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_012902809eb8aa97a5e678ab61"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6233982303bb01ce3e1abfa67c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4958c9db662c0a6cd73aa55d2b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_875fc3d58f7b42b6e12b748301"`);
        await queryRunner.query(`DROP TABLE "signal_events"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8404eecc9e43e246ded04c5748"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cfb2c9fbdf16b78c560cfeab6b"`);
        await queryRunner.query(`DROP TABLE "signals"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9d37ab4b5b9abc61a453654839"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_becc1908e607b73675b6e7f335"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_87f64b3f848f52bf561bb5959b"`);
        await queryRunner.query(`DROP TABLE "sequence_step_runs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d1ab86f9f16d30a2d05cb07177"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a3a9b1a642dd42c58b5595640e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dbe0f6e04fd9d458c376c3a38c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1587e1c3f169ceb2f148c31176"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b7e47715956a46c3847ce5d891"`);
        await queryRunner.query(`DROP TABLE "sequence_enrollments"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_eb66c610eb3d96f66c35fa15a0"`);
        await queryRunner.query(`DROP TABLE "sequence_steps"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0ada014ecbfc9ad7a0ef465821"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b158cdd1c39ffeb75863e7e2ba"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5218dd1caf9a9b1ed3b5ebaac5"`);
        await queryRunner.query(`DROP TABLE "sequences"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2908e938bf40936ef6d3954470"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_695cc5425122f2325b39544a7d"`);
        await queryRunner.query(`DROP TABLE "suppressions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_94aa9cdb289d03202f0bf2bfef"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5383feac2144f5b54f1ff44094"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_823726e0acc9be30241813fbf7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0475b6d437b908dac4a4e768b5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2bddf29f25d4a1752ea6eadc63"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_47d9a8dbb573521810a5b2c3dc"`);
        await queryRunner.query(`DROP TABLE "activities"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3991be6470f78d56144b155bb5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d09133ea83c39ca3ef9658df69"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0a808d4f61d0b204f3554367e4"`);
        await queryRunner.query(`DROP TABLE "deal_contacts"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_43ebfc877f6a4a18a232f6d7c9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_67282fe42388eefa1de17cb7de"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_be8282d6fa0ac87f2eb85b5d90"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_251df647cb9cc143e2488db3a1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c419cf497b3eac82f1b6d653c7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_feb688fb4f152b0ca1228e449e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_98de6ef1bebb17bb0b74cef931"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_837b88803d23a79b88ebd9bd2c"`);
        await queryRunner.query(`DROP TABLE "deals"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6096ae381257efae65adeca4e6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8f0ac964a423c9d8563ccfb148"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_798eb7ffe0257287aee4db7770"`);
        await queryRunner.query(`DROP TABLE "deal_stages"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fff8748b888856f6c7625cc11b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_38d8fa59e9edbde3bd66eb3d77"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a4c488d49a53802623d18884fd"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d321a5c3695ceb8ee8f5655988"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c45581301c84a8b96f4f5174cc"`);
        await queryRunner.query(`DROP TABLE "contacts"`);
    }

}
