// Cálculo del valor a cobrar. Se deja aparte para poder probarlo fácil.
//
// Reglas:
//  - Se cobra por hora o fracción, mínimo 1 hora.
//  - "minutos_gracia" es la tolerancia: si se pasa de la hora solo esos minutos, no se cobra otra hora.
//  - "tope_dia" (si es mayor que 0) es lo máximo que se cobra por cada bloque de 24 horas.
function calcularValor(minutos, tarifa) {
  const valorHora = Number(tarifa.valor_hora) || 0;
  const gracia = Number(tarifa.minutos_gracia) || 0;
  const tope = Number(tarifa.tope_dia) || 0;

  const porHoras = (m) => Math.max(1, Math.ceil((m - gracia) / 60)) * valorHora;

  if (!tope) return porHoras(minutos);

  const dias = Math.floor(minutos / 1440);
  const resto = minutos % 1440;
  let valor = dias * tope;
  if (dias === 0 || resto > gracia) valor += Math.min(tope, porHoras(resto));
  return valor;
}

module.exports = { calcularValor };
