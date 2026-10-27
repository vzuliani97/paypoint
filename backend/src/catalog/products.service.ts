import { Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error';
import { DatabaseService } from '../database/database.service';

export type ProductType = 'TOPUP' | 'GIFT_CARD';

export interface Product {
  id: number;
  code: string;
  name: string;
  type: ProductType;
  minAmount: number;
  maxAmount: number;
}

interface ProductRow {
  id: number;
  code: string;
  name: string;
  type: ProductType;
  min_amount: number;
  max_amount: number;
}

const toProduct = (row: ProductRow): Product => ({
  id: row.id,
  code: row.code,
  name: row.name,
  type: row.type,
  minAmount: row.min_amount,
  maxAmount: row.max_amount,
});

@Injectable()
export class ProductsService {
  constructor(private readonly db: DatabaseService) {}

  async listActive(): Promise<Product[]> {
    const { rows } = await this.db.query<ProductRow>(
      'SELECT id, code, name, type, min_amount, max_amount FROM products WHERE active ORDER BY name',
    );
    return rows.map(toProduct);
  }

  async getActive(productId: number): Promise<Product> {
    const { rows } = await this.db.query<ProductRow>(
      'SELECT id, code, name, type, min_amount, max_amount FROM products WHERE id = $1 AND active',
      [productId],
    );

    if (rows.length === 0) {
      throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found or inactive');
    }

    return toProduct(rows[0]);
  }
}
