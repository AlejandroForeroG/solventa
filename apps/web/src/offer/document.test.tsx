import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18n } from '../i18n/I18n';
import { DocumentFields } from './DocumentFields';

it('presents sealed values readably while retaining unknown fields and verification metadata', () => {
  const document = { coverage: { kind: 'mortgage_life', sumInsured: '200000000.1250' }, premium: '48600.0000', currency: 'COP', offerId: 'original-offer', extraClause: 'Original clause', synthetic: true };
  const bytes = JSON.stringify(document);
  const { container } = render(<I18n initial="es-CO"><DocumentFields document={document} /></I18n>);
  expect(screen.getByText(/200\.000\.000,125/)).toBeInTheDocument();
  expect(screen.getByText('Vida · saldo deudor')).toBeInTheDocument();
  expect(screen.getByText('Original clause')).toBeInTheDocument();
  expect(container.querySelector('details')).toHaveTextContent('original-offer');
  expect(container.querySelector('pre')).toBeNull();
  expect(JSON.stringify(document)).toBe(bytes);
});
