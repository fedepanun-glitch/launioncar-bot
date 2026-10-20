-- =====================================================================
-- GASTOS DEL SEMIRREMOLQUE
-- Un gasto puede ser del semi (gomas, reparación, cisterna...). Queda registrado en el semi
-- aunque después cambie de camión, y sigue contando en el camión que lo llevaba ese día.
-- Se puede correr más de una vez. No borra datos.
-- =====================================================================
alter table public.gastos_camiones add column if not exists semirremolque_id uuid
  references public.semirremolques(id) on delete set null;
create index if not exists gastos_camiones_semi_idx on public.gastos_camiones (semirremolque_id);

select count(*) as gastos, count(semirremolque_id) as gastos_de_semis from public.gastos_camiones;
