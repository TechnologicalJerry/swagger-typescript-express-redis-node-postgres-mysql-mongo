-- CreateTable
CREATE TABLE "inventories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" VARCHAR(36) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chk_inventory_quantity_non_negative" CHECK ("quantity" >= 0),
    CONSTRAINT "chk_inventory_reserved_non_negative" CHECK ("reserved_quantity" >= 0),
    CONSTRAINT "chk_inventory_reserved_lte_quantity" CHECK ("reserved_quantity" <= "quantity")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventories_product_id_key" ON "inventories"("product_id");
CREATE INDEX "inventories_product_id_idx" ON "inventories"("product_id");
