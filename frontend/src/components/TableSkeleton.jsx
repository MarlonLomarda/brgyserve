export default function TableSkeleton({ col = 5, row = 5 }) {
  return (
    <>
      {Array.from({ length: row }).map((_, rowIndex) => (
        <tr key={rowIndex}>
          {Array.from({ length: col }).map((_, colIndex) => (
            <td key={colIndex}>
              <div className="skeleton skeleton-cell"></div>
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
